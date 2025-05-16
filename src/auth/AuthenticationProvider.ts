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

// Define a type for the outcome of token validation
interface TokenValidityResult {
    isValid: boolean;
    isNetworkError: boolean; // True if the failure was due to network/server issues, not explicit invalidation
    isInvalidAuth: boolean; // True if server responded with 401 or 403
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

                    // Optimistically load the session
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

                    await this.stateManager.updateAuthState({
                        isAuthenticated: true,
                        gitlabCredentials: {
                            token: sessionData.gitlabToken,
                            url: sessionData.gitlabUrl,
                        },
                        // gitlabInfo will be updated by verifyAndRefreshSessionDetails
                    });

                    this._onDidChangeSessions.fire({
                        added: this._sessions,
                        removed: [],
                        changed: [],
                    });
                    this._onDidChangeAuthentication.fire();

                    // Start background verification without blocking initialization
                    this.verifyAndRefreshSessionDetails(sessionData.accessToken).catch((error) => {
                        console.error("Error during background session verification:", error);
                    });
                } else {
                    // No stored session, ensure state is clean
                    await this.stateManager.updateAuthState({
                        isAuthenticated: false,
                        gitlabCredentials: undefined,
                        gitlabInfo: undefined,
                    });
                }
            } catch (error) {
                console.error("Failed to initialize authentication:", error);
                // Attempt to clean up state if there was a critical error during init
                await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
                this._sessions = [];
                await this.stateManager.updateAuthState({
                    isAuthenticated: false,
                    gitlabCredentials: undefined,
                    gitlabInfo: undefined,
                });
                this._onDidChangeSessions.fire({ added: [], removed: this._sessions, changed: [] });
                this._onDidChangeAuthentication.fire();
            } finally {
                this._initialized = true;
            }
        })();

        return this.initializePromise;
    }

    private async checkTokenValidity(token: string): Promise<TokenValidityResult> {
        try {
            const response = await fetch(`${this.apiEndpoint}/auth/me`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json",
                },
            });

            if (response.ok) {
                return { isValid: true, isNetworkError: false, isInvalidAuth: false };
            } else if (response.status === 401 || response.status === 403) {
                console.warn(`Token validation failed with status: ${response.status}`);
                return { isValid: false, isNetworkError: false, isInvalidAuth: true };
            } else {
                // Other HTTP errors are treated as network/server issues for now
                console.error(
                    `Token validation encountered server error: ${response.status}`,
                    await response.text()
                );
                return { isValid: false, isNetworkError: true, isInvalidAuth: false };
            }
        } catch (error) {
            console.error("Token validation failed due to network error:", error);
            return { isValid: false, isNetworkError: true, isInvalidAuth: false };
        }
    }

    private async verifyAndRefreshSessionDetails(accessToken: string): Promise<void> {
        const validity = await this.checkTokenValidity(accessToken);

        if (!validity.isValid) {
            if (validity.isInvalidAuth) {
                // Token is explicitly invalid (401/403), clear the session
                console.log("Authentication token is invalid. Clearing session.");
                await this.context.secrets.delete(FrontierAuthProvider.SESSION_SECRET_KEY);
                const removedSessions = this._sessions;
                this._sessions = [];
                await this.stateManager.updateAuthState({
                    isAuthenticated: false,
                    gitlabCredentials: undefined,
                    gitlabInfo: undefined, // Ensure cleared here as well
                });
                if (removedSessions.length > 0) {
                    this._onDidChangeSessions.fire({
                        added: [],
                        removed: removedSessions,
                        changed: [],
                    });
                    this._onDidChangeAuthentication.fire();
                }
            } else if (validity.isNetworkError) {
                // Network error, keep the cached session for now.
                console.warn(
                    "Network error during token validation. Keeping cached session for now."
                );
            }
            return; // Stop further processing if token is not valid or network error
        }

        // Token is valid. Since GitLab info fetching is being removed,
        // we just ensure the authentication state is consistent and gitlabInfo is undefined.
        if (this._sessions.length > 0) {
            // Session exists and token is valid.
            await this.stateManager.updateAuthState({
                isAuthenticated: true, // Reaffirm authentication
                gitlabInfo: undefined, // Explicitly set to undefined as we are no longer fetching it.
            });
        }
        // If no session exists here but token was valid (e.g. called directly after a token set but before session obj update),
        // the primary session creation/update flows in login/setTokens/initialize handle state updates.
        // This function primarily ensures that for an *existing, validated* session, gitlabInfo is cleared.
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
            // Also clear from state manager
            await this.stateManager.updateAuthState({
                isAuthenticated: false,
                gitlabCredentials: undefined,
                gitlabInfo: undefined,
            });
        }
    }

    // Helper methods for your extension to use
    get isAuthenticated(): boolean {
        return this._sessions.length > 0;
    }

    async getToken(): Promise<string | undefined> {
        if (!this._initialized) {
            await this.initialize();
        }
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
            const error = new Error(
                `Request failed with status ${response.status}: ${errorText || "Server returned an error"}`
            ) as any;
            error.status = response.status;
            error.errorText = errorText; // Store original error text if needed later
            throw error;
        }
        return response.json();
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
                gitlabCredentials: {
                    token: sessionData.gitlabToken,
                    url: sessionData.gitlabUrl,
                },
                gitlabInfo: undefined, // Will be updated by GitLab info fetch after login/register
            });

            // After setting new tokens (login/register), immediately verify and fetch GitLab info
            this.verifyAndRefreshSessionDetails(tokenResponse.access_token).catch((error) => {
                console.error("Error during post-token-set session verification:", error);
            });
        } catch (error) {
            console.error("Failed to store authentication tokens:", error);
            throw new Error("Failed to save authentication state");
        }
    }
}
