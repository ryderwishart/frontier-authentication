import * as vscode from 'vscode';

export class FrontierAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
    private static readonly AUTH_TYPE = 'frontier';
    private static readonly AUTH_NAME = 'Frontier Authentication';

    private _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;

    private _sessions: vscode.AuthenticationSession[] = [];
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
            // Try to restore token from secret storage
            const token = await this.context.secrets.get('auth-token');
            if (token) {
                this._sessions = [{
                    id: 'frontier-session',
                    accessToken: token,
                    account: {
                        id: 'frontier-user',
                        label: 'Frontier User'
                    },
                    scopes: ['token']
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
            await this.context.secrets.delete('auth-token');
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
}