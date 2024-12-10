import * as vscode from "vscode";

export class MockAuthenticationProvider
    implements vscode.AuthenticationProvider, vscode.Disposable
{
    private sessions: vscode.AuthenticationSession[] = [];
    private _onDidChangeSessions =
        new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    readonly onDidChangeSessions = this._onDidChangeSessions.event;
    private disposable: vscode.Disposable | undefined;

    constructor(private readonly providerId: string) {
        this.sessions = [];
    }

    dispose(): void {
        this.sessions = [];
        this._onDidChangeSessions.fire({
            added: [],
            removed: [...this.sessions],
            changed: [],
        });
        this._onDidChangeSessions.dispose();
        if (this.disposable) {
            this.disposable.dispose();
            this.disposable = undefined;
        }
    }

    createMockSession(): vscode.AuthenticationSession {
        return {
            id: "mock-session-id",
            accessToken: "mock-token",
            account: {
                id: "mock-user-id",
                label: "Mock User",
            },
            scopes: [],
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
            changed: [],
        });
        return session;
    }

    async removeSession(sessionId: string): Promise<void> {
        const removedSession = this.sessions.find((session) => session.id === sessionId);
        this.sessions = this.sessions.filter((session) => session.id !== sessionId);
        if (removedSession) {
            this._onDidChangeSessions.fire({
                added: [],
                removed: [removedSession],
                changed: [],
            });
        }
    }

    setDisposable(disposable: vscode.Disposable) {
        if (this.disposable) {
            this.disposable.dispose();
        }
        this.disposable = disposable;
    }

    async clearSessions(): Promise<void> {
        const removedSessions = [...this.sessions];
        this.sessions = [];
        if (removedSessions.length > 0) {
            this._onDidChangeSessions.fire({
                added: [],
                removed: removedSessions,
                changed: [],
            });
        }
    }
}

export async function registerMockAuthProvider(): Promise<vscode.Disposable> {
    try {
        await vscode.authentication.getSession("frontier", [], { createIfNone: false });
        return new vscode.Disposable(() => {});
    } catch (error) {
        // Create a mock provider that automatically "logs in"
        const mockProvider = new MockAuthenticationProvider("frontier");
        const disposable = vscode.authentication.registerAuthenticationProvider(
            "frontier",
            "Frontier Mock Auth",
            mockProvider,
            { supportsMultipleAccounts: false }
        );

        // Automatically create a session when login is triggered
        vscode.commands.registerCommand("frontier.login", async () => {
            return await mockProvider.createSession([]);
        });

        return disposable;
    }
}
