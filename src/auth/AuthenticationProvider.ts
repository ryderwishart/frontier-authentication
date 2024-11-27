import * as vscode from "vscode";
import { StateManager } from "../state";

// Add interface for token response
interface TokenResponse {
    access_token: string;
    token_type: string;
    gitlab_token: string;
    gitlab_url: string;
}

// Add interface for stored session data
interface FrontierSessionData {
    accessToken: string;
    gitlabToken: string;
    gitlabUrl: string;
}

// Add at the top of the file with other interfaces
interface ExtendedAuthSession extends vscode.AuthenticationSession {
    gitlabToken?: string;
    gitlabUrl?: string;
}

interface GitLabInfoResponse {
    user_id: number;
    username: string;
    project_count: number;
}

export class FrontierAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
    private static readonly AUTH_TYPE = "frontier";
    private static readonly AUTH_NAME = "Frontier Authentication";

    private static readonly SESSION_SECRET_KEY = "frontier-session-data";

    private _onDidChangeSessions =
        new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;

    private _sessions: ExtendedAuthSession[] = [];
    private _initialized = false;
    private initializePromise: Promise<void> | null = null;

    private _onDidChangeAuthentication = new vscode.EventEmitter<void>();
    readonly onDidChangeAuthentication = this._onDidChangeAuthentication.event;

    private readonly stateManager: StateManager;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly apiEndpoint: string,
        stateManager: StateManager
    ) {
        this.stateManager = stateManager;

        // Register the auth provider
        context.subscriptions.push(
            vscode.authentication.registerAuthenticationProvider(
                FrontierAuthProvider.AUTH_TYPE,
                FrontierAuthProvider.AUTH_NAME,
                this
            )
        );
    }

    public async initialize(): Promise<void> {
        // Ensure we only initialize once
        if (this.initializePromise) {
            return this.initializePromise;
        }

        this.initializePromise = (async () => {
            try {
                const sessionDataStr = await this.context.secrets.get(
                    FrontierAuthProvider.SESSION_SECRET_KEY
                );
                if (sessionDataStr) {
                    const sessionData: FrontierSessionData = JSON.parse(sessionDataStr);

                    // Validate the stored token by making a test API call
                    const isValid = await this.validateStoredToken(sessionData.accessToken);

                    if (isValid) {
                        this._sessions = [
                            {
                                id: "frontier-session",
                                accessToken: sessionData.accessToken,
                                account: {
                                    id: "frontier-user",
                                    label: "Frontier User",
                                },
                                scopes: ["token"],
                                gitlabToken: sessionData.gitlabToken,
                                gitlabUrl: sessionData.gitlabUrl,
                            },
                        ];

                        // Update state manager with restored session data
                        await this.stateManager.updateAuthState({
                            isAuthenticated: true,
                            gitlabCredentials: {
                                token: sessionData.gitlabToken,
                                url: sessionData.gitlabUrl,
                            },
                        });

                        // Fetch and update GitLab info
                        try {
                            const gitlabInfo = await this.fetchGitLabInfo();
                            await this.stateManager.updateAuthState({ gitlabInfo });
                        } catch (error) {
                            console.error(
                                "Failed to fetch GitLab info during session restore:",
                                error
                            );
                        }

                        this._onDidChangeSessions.fire({
                            added: this._sessions,
                            removed: [],
                            changed: [],
                        });
                        this._onDidChangeAuthentication.fire();
                    } else {
                        // If token is invalid, clean up stored data
                        await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
                        await this.stateManager.updateAuthState({
                            isAuthenticated: false,
                            gitlabCredentials: undefined,
                            gitlabInfo: undefined,
                        });
                    }
                }
            } catch (error) {
                console.error("Failed to restore authentication:", error);
                // Don't show error message here - just log it
            } finally {
                this._initialized = true;
            }
        })();

        return this.initializePromise;
    }

    private async validateStoredToken(token: string): Promise<boolean> {
        try {
            const response = await fetch(`${this.apiEndpoint}/auth/me`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // Update getSessions to ensure initialization is complete
    async getSessions(): Promise<vscode.AuthenticationSession[]> {
        if (!this._initialized) {
            await this.initialize();
        }
        return [...this._sessions];
    }

    async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
        // This would be where you implement your login flow
        // For now, we'll just throw as this should be handled by your webview
        throw new Error("Please use the login button in the Frontier sidebar to authenticate");
    }

    async removeSession(sessionId: string): Promise<void> {
        const sessionIdx = this._sessions.findIndex((session) => session.id === sessionId);
        if (sessionIdx > -1) {
            const removed = this._sessions.splice(sessionIdx, 1);
            await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
            this._onDidChangeSessions.fire({ added: [], removed, changed: [] });
            this._onDidChangeAuthentication.fire();
        }
    }

    // Helper methods for your extension to use
    get isAuthenticated(): boolean {
        return this._sessions.length > 0;
    }

    async getToken(): Promise<string | undefined> {
        return this._sessions[0]?.accessToken;
    }

    async setToken(token: string): Promise<void> {
        try {
            await this.context.secrets.store("auth-token", token);

            const session: vscode.AuthenticationSession = {
                id: "frontier-session",
                accessToken: token,
                account: {
                    id: "frontier-user",
                    label: "Frontier User",
                },
                scopes: ["token"],
            };

            this._sessions = [session];
            this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
            this._onDidChangeAuthentication.fire();
        } catch (error) {
            console.error("Failed to store authentication token:", error);
            throw new Error("Failed to save authentication state");
        }
    }

    async logout(): Promise<void> {
        await this.removeSession("frontier-session");
        await this.stateManager.updateAuthState({
            isAuthenticated: false,
            gitlabInfo: undefined,
        });
    }

    async login(username: string, password: string): Promise<boolean> {
        try {
            const formData = new URLSearchParams({
                username: username,
                password: password,
                grant_type: "password",
                scope: "",
            });

            const response = await fetch(`${this.apiEndpoint}/auth/token`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
                },
                body: formData,
            });

            if (!response.ok) {
                return false;
            }

            const result = await response.json();

            // Validate required fields
            if (!result.gitlab_token || !result.gitlab_url) {
                throw new Error("Invalid server response: missing GitLab credentials");
            }

            // Store all tokens
            await this.setTokens(result);

            // Get state manager instance and update GitLab credentials
            await this.stateManager.updateGitLabCredentials({
                token: result.gitlab_token,
                url: result.gitlab_url,
            });

            return true;
        } catch (error) {
            console.error("Login error:", error);
            return false;
        }
    }

    private validatePassword(password: string) {
        if (password.length < 8) {
            throw new Error("Password must be at least 8 characters long");
        }
        // Add any other password validation rules here
    }

    private async handleResponse<T>(response: Response): Promise<T> {
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || "Request failed");
        }
        return response.json();
    }

    private async fetchGitLabInfo() {
        try {
            const token = await this.getToken();
            if (!token) {
                throw new Error("No authentication token found");
            }

            const response = await fetch(`${this.apiEndpoint}/gitlab/info`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
            });

            const gitlabInfo = (await this.handleResponse(response)) as GitLabInfoResponse;
            await this.stateManager.updateAuthState({
                isAuthenticated: true,
                gitlabInfo,
            });

            return gitlabInfo;
        } catch (error) {
            console.error("Error fetching GitLab info:", error);
            throw error;
        }
    }

    async register(username: string, email: string, password: string): Promise<boolean> {
        try {
            this.validatePassword(password);

            const response = await fetch(`${this.apiEndpoint}/auth/register`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({
                    username,
                    email,
                    password,
                }),
            });

            const result = await this.handleResponse<TokenResponse>(response);

            // Validate required fields
            if (!result.gitlab_token || !result.gitlab_url) {
                throw new Error("Invalid server response: missing GitLab credentials");
            }

            // Store all tokens
            await this.setTokens(result);

            // Get state manager instance and update GitLab credentials
            await this.stateManager.updateGitLabCredentials({
                token: result.gitlab_token,
                url: result.gitlab_url,
            });

            // Fetch GitLab info and update state
            // await this.fetchGitLabInfo(); // NOTE: now we just access gitlab directly with the user's gitlab token create during registration, so we don't need this anymore.

            return true;
        } catch (error) {
            console.error("Registration error:", error);
            throw error; // Re-throw to let the command handler show the error
        }
    }

    getAuthStatus(): { isAuthenticated: boolean; gitlabInfo?: any } {
        return {
            isAuthenticated: this.isAuthenticated,
            gitlabInfo: this.stateManager.getAuthState().gitlabInfo,
        };
    }

    onAuthStatusChanged(
        callback: (status: { isAuthenticated: boolean; gitlabInfo?: any }) => void
    ): vscode.Disposable {
        return this._onDidChangeAuthentication.event(() => {
            callback(this.getAuthStatus());
        });
    }

    dispose() {
        this._onDidChangeSessions.dispose();
        this._onDidChangeAuthentication.dispose();
    }

    // Add methods to get GitLab credentials
    async getGitLabToken(): Promise<string | undefined> {
        return (this._sessions[0] as any)?.gitlabToken;
    }

    async getGitLabUrl(): Promise<string | undefined> {
        return (this._sessions[0] as any)?.gitlabUrl;
    }

    async setTokens(tokenResponse: TokenResponse): Promise<void> {
        try {
            const sessionData: FrontierSessionData = {
                accessToken: tokenResponse.access_token,
                gitlabToken: tokenResponse.gitlab_token,
                gitlabUrl: tokenResponse.gitlab_url,
            };

            // Store all session data as JSON string
            await this.context.secrets.store(
                FrontierAuthProvider.SESSION_SECRET_KEY,
                JSON.stringify(sessionData)
            );

            const session: ExtendedAuthSession = {
                id: "frontier-session",
                accessToken: tokenResponse.access_token,
                account: {
                    id: "frontier-user",
                    label: "Frontier User",
                },
                scopes: ["token"],
                // Add GitLab properties
                gitlabToken: tokenResponse.gitlab_token,
                gitlabUrl: tokenResponse.gitlab_url,
            };

            this._sessions = [session];
            this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
            this._onDidChangeAuthentication.fire();

            await this.stateManager.updateAuthState({
                isAuthenticated: true,
                gitlabInfo: undefined, // Will be updated by GitLab info fetch
            });
        } catch (error) {
            console.error("Failed to store authentication tokens:", error);
            throw new Error("Failed to save authentication state");
        }
    }
}
