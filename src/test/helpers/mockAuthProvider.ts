import * as vscode from 'vscode';

export class MockAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
    private sessions: vscode.AuthenticationSession[] = [];
    private _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;

    constructor(private readonly providerId: string) {}

    dispose(): void {
        this._onDidChangeSessions.dispose();
    }

    createMockSession(): vscode.AuthenticationSession {
        return {
            id: 'mock-session-id',
            accessToken: 'mock-token',
            account: {
                id: 'mock-user-id',
                label: 'Mock User'
            },
            scopes: []
        };
    }

    async getSessions(
        scopes: readonly string[] | undefined,
        options: vscode.AuthenticationProviderSessionOptions = {}
    ): Promise<vscode.AuthenticationSession[]> {
        return [...this.sessions];
    }

    async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
        const session = this.createMockSession();
        this.sessions.push(session);
        this._onDidChangeSessions.fire({
            added: [session],
            removed: [],
            changed: []
        });
        return session;
    }

    async removeSession(sessionId: string): Promise<void> {
        const removedSession = this.sessions.find(session => session.id === sessionId);
        this.sessions = this.sessions.filter(session => session.id !== sessionId);
        if (removedSession) {
            this._onDidChangeSessions.fire({
                added: [],
                removed: [removedSession],
                changed: []
            });
        }
    }
}

export function registerMockAuthProvider(): vscode.Disposable {
    const provider = new MockAuthenticationProvider('frontier');
    const disposable = vscode.authentication.registerAuthenticationProvider(
        'frontier',
        'Frontier Authentication',
        provider,
        { supportsMultipleAccounts: false }
    );

    return new vscode.Disposable(() => {
        provider.dispose();
        disposable.dispose();
    });
} 