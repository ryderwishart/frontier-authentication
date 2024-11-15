import * as vscode from 'vscode';

export class AuthenticationProvider implements vscode.Disposable {
    private _onDidChangeAuthentication = new vscode.EventEmitter<void>();
    readonly onDidChangeAuthentication = this._onDidChangeAuthentication.event;

    private _isAuthenticated: boolean = false;
    private _token: string | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.initialize();
    }

    private async initialize() {
        // Try to restore token from secret storage
        const token = await this.context.secrets.get('auth-token');
        if (token) {
            this._token = token;
            this._isAuthenticated = true;
            this._onDidChangeAuthentication.fire();
        }
    }

    get isAuthenticated(): boolean {
        return this._isAuthenticated;
    }

    async getToken(): Promise<string | undefined> {
        return this._token;
    }

    async setToken(token: string): Promise<void> {
        await this.context.secrets.store('auth-token', token);
        this._token = token;
        this._isAuthenticated = true;
        this._onDidChangeAuthentication.fire();
    }

    async logout(): Promise<void> {
        await this.context.secrets.delete('auth-token');
        this._token = undefined;
        this._isAuthenticated = false;
        this._onDidChangeAuthentication.fire();
    }

    dispose() {
        this._onDidChangeAuthentication.dispose();
    }
}