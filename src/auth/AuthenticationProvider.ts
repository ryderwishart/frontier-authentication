import * as vscode from 'vscode';

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

export class FrontierAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
    private static readonly AUTH_TYPE = 'frontier';
    private static readonly AUTH_NAME = 'Frontier Authentication';

    private static readonly SESSION_SECRET_KEY = 'frontier-session-data';

    private _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;

    private _sessions: ExtendedAuthSession[] = [];
    private _initialized = false;

    private _onDidChangeAuthentication = new vscode.EventEmitter<void>();
    readonly onDidChangeAuthentication = this._onDidChangeAuthentication.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Register the auth provider
        context.subscriptions.push(
            vscode.authentication.registerAuthenticationProvider(
                FrontierAuthProvider.AUTH_TYPE,
                FrontierAuthProvider.AUTH_NAME,
                this
            )
        );
        this.initialize();
    }

    private async initialize() {
        try {
            const sessionDataStr = await this.context.secrets.get(FrontierAuthProvider.SESSION_SECRET_KEY);
            if (sessionDataStr) {
                const sessionData: FrontierSessionData = JSON.parse(sessionDataStr);
                this._sessions = [{
                    id: 'frontier-session',
                    accessToken: sessionData.accessToken,
                    account: {
                        id: 'frontier-user',
                        label: 'Frontier User'
                    },
                    scopes: ['token'],
                    // Store additional data in session object
                    gitlabToken: sessionData.gitlabToken,
                    gitlabUrl: sessionData.gitlabUrl
                }];
                this._onDidChangeSessions.fire({ added: this._sessions, removed: [], changed: [] });
            }
            this._initialized = true;
        } catch (error) {
            console.error('Failed to restore authentication:', error);
            vscode.window.showErrorMessage('Failed to restore authentication state');
        }
    }

    async getSessions(
        scopes: readonly string[] | undefined,
        options: vscode.AuthenticationProviderSessionOptions
    ): Promise<vscode.AuthenticationSession[]> {
        // Convert readonly array to mutable array
        return Promise.resolve([...this._sessions]);
    }

    async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
        // This would be where you implement your login flow
        // For now, we'll just throw as this should be handled by your webview
        throw new Error('Please use the login button in the Frontier sidebar to authenticate');
    }

    async removeSession(sessionId: string): Promise<void> {
        const sessionIdx = this._sessions.findIndex(session => session.id === sessionId);
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
            await this.context.secrets.store('auth-token', token);

            const session: vscode.AuthenticationSession = {
                id: 'frontier-session',
                accessToken: token,
                account: {
                    id: 'frontier-user',
                    label: 'Frontier User'
                },
                scopes: ['token']
            };

            this._sessions = [session];
            this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
            this._onDidChangeAuthentication.fire();
        } catch (error) {
            console.error('Failed to store authentication token:', error);
            throw new Error('Failed to save authentication state');
        }
    }

    async logout(): Promise<void> {
        await this.removeSession('frontier-session');
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
                gitlabUrl: tokenResponse.gitlab_url
            };

            // Store all session data as JSON string
            await this.context.secrets.store(
                FrontierAuthProvider.SESSION_SECRET_KEY,
                JSON.stringify(sessionData)
            );

            const session: ExtendedAuthSession = {
                id: 'frontier-session',
                accessToken: tokenResponse.access_token,
                account: {
                    id: 'frontier-user',
                    label: 'Frontier User'
                },
                scopes: ['token'],
                // Add GitLab properties
                gitlabToken: tokenResponse.gitlab_token,
                gitlabUrl: tokenResponse.gitlab_url
            };

            this._sessions = [session];
            this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
            this._onDidChangeAuthentication.fire();
        } catch (error) {
            console.error('Failed to store authentication tokens:', error);
            throw new Error('Failed to save authentication state');
        }
    }
}