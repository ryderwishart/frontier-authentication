import * as vscode from 'vscode';
import { FrontierAuthProvider } from '../auth/AuthenticationProvider';
import { getNonce } from '../utils';
import fetch, { Response } from 'node-fetch';
import { URLSearchParams } from 'url';
import { StateManager } from '../state';
import { AuthState } from '../types/state';
import { GitService } from '../git/GitService';

// Combined message types
interface LoginMessage {
    type: 'login';
    username: string;
    password: string;
}

interface RegisterMessage {
    type: 'register';
    username: string;
    email: string;
    password: string;
}

interface ErrorMessage {
    type: 'error';
    message: string;
}

interface ViewChangeMessage {
    type: 'viewChange';
    view: 'login' | 'register';
}

interface StatusMessage {
    type: 'status';
    authStatus: 'authenticated' | 'unauthenticated';
    connectionStatus: 'connected' | 'disconnected';
}

// Add new interface for GitLab info
interface GitLabInfo {
    user_id: number;
    username: string;
    project_count: number;
}

// Add new message type for GitLab info
interface GitLabInfoMessage {
    type: 'gitlabInfo';
    info: GitLabInfo;
}

// Add new interface for repository status
interface RepoStatus {
    hasRemote: boolean;
    projectName?: string;
    projectUrl?: string;
}

interface RepoStatusMessage {
    type: 'repoStatus';
    status: RepoStatus;
}

// Add at the top with other interfaces
interface TokenResponse {
    access_token: string;
    token_type: string;
    gitlab_token: string;
    gitlab_url: string;
}

interface GitLabInfoResponse {
    user_id: number;
    username: string;
    project_count: number;
}

// Update WebviewMessage type
type WebviewMessage = LoginMessage | RegisterMessage | ErrorMessage | ViewChangeMessage | StatusMessage | GitLabInfoMessage | RepoStatusMessage;

export class AuthWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'frontier.auth';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly authProvider: FrontierAuthProvider,
        private readonly apiEndpoint: string,
        private readonly stateManager: StateManager,
        private readonly initialAuthState: AuthState
    ) {
        this.authProvider.onDidChangeAuthentication(() => {
            this.updateWebviewContent();
        });

        this.stateManager.onDidChangeState(() => {
            this.updateWebviewContent();
        });
    }

    public refresh(): void {
        this.updateWebviewContent();
    }

    async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        // Set initial content with loading state
        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Set up message handlers
        webviewView.webview.onDidReceiveMessage(async (data: WebviewMessage) => {
            await this.handleWebviewMessage(data, webviewView);
        });

        // If we're authenticated, fetch GitLab info after initial render
        if (this.stateManager.getAuthState().isAuthenticated) {
            await this.fetchGitLabInfo();
        }
    }

    private async handleWebviewMessage(message: any, webviewView: vscode.WebviewView) {
        switch (message.type) {
            case 'login':
                await this.handleLogin(message, webviewView);
                break;
            case 'register':
                await this.handleRegister(message, webviewView);
                break;
            case 'viewChange':
                await this.stateManager.updateAuthState({ currentView: message.view });
                break;
        }

        // Handle sync command
        if (message.command === 'sync') {
            try {
                await vscode.commands.executeCommand('frontier.syncChanges');
            } catch (error) {
                webviewView.webview.postMessage({
                    type: 'error',
                    message: error instanceof Error ? error.message : 'Failed to sync changes'
                });
            }
        }
    }

    private async updateWebviewContent(): Promise<void> {
        if (!this._view) {
            return;
        }

        // Update the HTML first
        this._view.webview.html = this.getHtmlContent(this._view.webview);

        // Then send all the current state information
        const state = this.stateManager.getAuthState();

        // Send authentication status
        this._view.webview.postMessage({
            type: 'status',
            authStatus: state.isAuthenticated ? 'authenticated' : 'unauthenticated',
            connectionStatus: state.connectionStatus
        });

        // Send GitLab info if available
        if (state.isAuthenticated && state.gitlabInfo) {
            this._view.webview.postMessage({
                type: 'gitlabInfo',
                info: state.gitlabInfo
            });
        }

        // Send repository status
        try {
            const repoStatus = await this.getRepoStatus();
            this._view.webview.postMessage({
                type: 'repoStatus',
                status: repoStatus
            });
        } catch (error) {
            console.error('Failed to update repo status:', error);
        }
    }

    private async handleLogin(data: LoginMessage, webviewView: vscode.WebviewView) {
        try {
            const formData = new URLSearchParams({
                username: data.username,
                password: data.password,
                grant_type: 'password',
                scope: ''
            });

            const response = await fetch(`${this.apiEndpoint}/auth/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json',
                },
                body: formData
            });

            const result = await this.handleResponse<TokenResponse>(response);

            // Validate required fields
            if (!result.gitlab_token || !result.gitlab_url) {
                throw new Error('Invalid server response: missing GitLab credentials');
            }

            // Store all tokens
            await this.authProvider.setTokens(result);

            // Update GitLab credentials in state
            await this.stateManager.updateGitLabCredentials({
                token: result.gitlab_token,
                url: result.gitlab_url
            });

            vscode.window.showInformationMessage('Successfully logged in!');

            // Fetch GitLab info and update the webview
            await this.fetchGitLabInfo();
            this.updateWebviewContent();

        } catch (error: unknown) {
            this.handleError(error, webviewView);
        }
    }

    private async handleRegister(data: RegisterMessage, webviewView: vscode.WebviewView) {
        try {
            this.validatePassword(data.password);

            const response = await fetch(`${this.apiEndpoint}/auth/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    username: data.username,
                    email: data.email,
                    password: data.password,
                }),
            });

            const result: TokenResponse = await this.handleResponse(response);

            // Validate required fields
            if (!result.gitlab_token || !result.gitlab_url) {
                throw new Error('Invalid server response: missing GitLab credentials');
            }

            // Store all tokens
            await this.authProvider.setTokens(result);

            // Update GitLab credentials in state
            await this.stateManager.updateGitLabCredentials({
                token: result.gitlab_token,
                url: result.gitlab_url
            });

            vscode.window.showInformationMessage('Successfully registered!');

            // Fetch GitLab info and update the webview
            await this.fetchGitLabInfo();
            this.updateWebviewContent();

        } catch (error: unknown) {
            this.handleError(error, webviewView);
        }
    }

    private validatePassword(password: string): void {
        if (password.length < 8) {
            throw new Error('Password must be at least 8 characters long');
        }
        if (!/[A-Z]/.test(password)) {
            throw new Error('Password must contain at least one uppercase letter');
        }
        if (!/[a-z]/.test(password)) {
            throw new Error('Password must contain at least one lowercase letter');
        }
        if (!/[0-9]/.test(password)) {
            throw new Error('Password must contain at least one number');
        }
    }

    private async handleResponse<T>(response: Response): Promise<T> {
        const rawText = await response.text();
        let result;
        try {
            result = JSON.parse(rawText);
        } catch (parseError) {
            throw new Error(`Server returned invalid JSON. Response: ${rawText.substring(0, 100)}...`);
        }

        if (!response.ok) {
            throw new Error(result?.detail || 'Operation failed');
        }

        return result as T;
    }

    private handleError(error: unknown, webviewView: vscode.WebviewView) {
        console.error('Operation error:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        webviewView.webview.postMessage({
            type: 'error',
            message: errorMessage
        });
    }

    private async fetchGitLabInfo(): Promise<void> {
        try {
            const token = await this.authProvider.getToken();
            if (!token) {
                return;
            }

            const gitlabResponse = await fetch(`${this.apiEndpoint}/auth/gitlab/info`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json',
                }
            });

            const result = await this.handleResponse<GitLabInfoResponse>(gitlabResponse);

            console.log('GitLab info:', result);
            // Update the state manager with the GitLab info
            await this.stateManager.updateAuthState({
                gitlabInfo: {
                    user_id: result.user_id,
                    username: result.username,
                    project_count: result.project_count
                }
            });

            // The webview will update automatically via the state change listener
        } catch (error) {
            console.log('GitLab info fetch failed (non-critical):', error);
            // Optionally update state to show error
            await this.stateManager.updateAuthState({ gitlabInfo: undefined });
        }
    }

    private async getRepoStatus(): Promise<RepoStatus> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                return { hasRemote: false };
            }

            const gitService = new GitService();
            const remoteUrl = await gitService.getRemoteUrl(workspaceFolder.uri.fsPath);

            if (!remoteUrl) {
                return { hasRemote: false };
            }

            // Parse project name and URL from remote
            const url = new URL(remoteUrl);
            const projectName = url.pathname.split('/').pop()?.replace('.git', '');

            return {
                hasRemote: true,
                projectName,
                projectUrl: remoteUrl.replace('.git', '')
            };
        } catch (error) {
            console.error('Error getting repo status:', error);
            return { hasRemote: false };
        }
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const nonce = getNonce();
        const state = this.stateManager.getAuthState();
        const currentView = state.currentView;

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <title>Authentication</title>
                <style>
                    body {
                        padding: 15px;
                        font-family: var(--vscode-font-family);
                        max-width: 100%;
                        box-sizing: border-box;
                        margin: 0;
                    }
                    .container {
                        position: relative;
                        width: 100%;
                        max-width: 100%;
                        box-sizing: border-box;
                    }
                    .auth-form {
                        display: none;
                        width: 100%;
                        max-width: 100%;
                    }
                    .auth-form.active {
                        display: block;
                    }
                    h2 {
                        margin-bottom: 15px;
                        color: var(--vscode-foreground);
                        word-wrap: break-word;
                    }
                    .info-text {
                        font-size: 12px;
                        color: var(--vscode-descriptionForeground);
                        margin-bottom: 15px;
                        word-wrap: break-word;
                    }
                    .form-group {
                        margin-bottom: 15px;
                        width: 100%;
                    }
                    input {
                        width: 100%;
                        padding: 8px;
                        border: 1px solid var(--vscode-input-border);
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        box-sizing: border-box;
                    }
                    .password-requirements {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        margin-top: 5px;
                        word-wrap: break-word;
                    }
                    button {
                        width: 100%;
                        padding: 8px;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        cursor: pointer;
                        box-sizing: border-box;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .error {
                        color: var(--vscode-errorForeground);
                        margin-top: 10px;
                        word-wrap: break-word;
                    }
                    .switch-view {
                        margin-top: 15px;
                        text-align: center;
                        font-size: 12px;
                        width: 100%;
                    }
                    .switch-view a {
                        color: var(--vscode-textLink-foreground);
                        text-decoration: none;
                    }
                    .switch-view a:hover {
                        color: var(--vscode-textLink-activeForeground);
                        text-decoration: underline;
                    }
                    .status-bar {
                        display: flex;
                        justify-content: space-between;
                        padding: 8px;
                        background: var(--vscode-sideBar-background);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        margin-bottom: 15px;
                        width: 100%;
                        box-sizing: border-box;
                    }
                    .status-item {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        min-width: 0;
                    }
                    .status-indicator {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        background: var(--vscode-errorForeground);
                        flex-shrink: 0;
                    }
                    .status-indicator.connected {
                        background: var(--vscode-testing-iconPassed);
                    }
                    .status-text {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                    }
                    .gitlab-info {
                        display: none;
                        margin-top: 20px;
                        padding: 10px;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        width: 100%;
                        box-sizing: border-box;
                    }
                    .info-section {
                        margin-bottom: 15px;
                        width: 100%;
                    }
                    .info-section h3 {
                        margin: 0 0 10px 0;
                        font-size: 14px;
                        color: var(--vscode-foreground);
                        word-wrap: break-word;
                    }
                    pre {
                        margin: 0;
                        padding: 8px;
                        background: var(--vscode-textBlockQuote-background);
                        border-radius: 3px;
                        font-family: var(--vscode-editor-font-family);
                        font-size: 12px;
                        overflow-x: auto;
                        color: var(--vscode-foreground);
                        width: 100%;
                        box-sizing: border-box;
                        white-space: pre-wrap;
                        word-wrap: break-word;
                    }
                    .repo-status {
                        margin-top: 1rem;
                        padding: 0.5rem;
                        border: 1px solid var(--vscode-button-background);
                        border-radius: 4px;
                    }
                    .repo-status a {
                        color: var(--vscode-textLink-foreground);
                        text-decoration: none;
                    }
                    .repo-status a:hover {
                        text-decoration: underline;
                    }
                    .sync-button {
                        margin-top: 0.5rem;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="status-bar">
                        <div class="status-item">
                            <span class="status-indicator ${state.isAuthenticated ? 'connected' : ''}"></span>
                            <span class="status-text">Authentication</span>
                        </div>
                        <div class="status-item">
                            <span class="status-indicator ${state.connectionStatus === 'connected' ? 'connected' : ''}"></span>
                            <span class="status-text">Server Connection</span>
                        </div>
                    </div>

                    ${state.isAuthenticated ? `
                        <!-- Authenticated View -->
                        <div class="auth-status">
                            <div class="info-section">
                                <h3>Authentication Status</h3>
                                <div class="info-text">
                                    ${state.gitlabInfo
                    ? `<p>✓ Logged in as <strong>${state.gitlabInfo.username}</strong></p>
                                           <p>Projects: ${state.gitlabInfo.project_count}</p>`
                    : '<p>✓ Authenticated</p>'
                }
                                </div>
                            </div>
                            
                            <div id="repoStatus" class="repo-status">
                                <!-- Repository status will be updated dynamically -->
                            </div>
                            
                            <button class="secondary-button" id="logoutButton">Log Out</button>
                        </div>
                    ` : `
                        <!-- Unauthenticated View -->
                        <div class="container ${currentView}">
                            <!-- Login Form -->
                            <form id="loginForm" class="auth-form ${currentView === 'login' ? 'active' : ''}">
                                <h2>Login</h2>
                                <div class="form-group">
                                    <input type="text" id="loginUsername" placeholder="Username" required>
                                </div>
                                <div class="form-group">
                                    <input type="password" id="loginPassword" placeholder="Password" required>
                                </div>
                                <button type="submit">Login</button>
                                <div class="switch-view">
                                    Don't have an account? <a href="#" id="showRegister">Register</a>
                                </div>
                            </form>

                            <!-- Register Form -->
                            <form id="registerForm" class="auth-form ${currentView === 'register' ? 'active' : ''}">
                                <h2>Register</h2>
                                <div class="info-text">
                                    This will create your Codex cloud account for backup and sync.
                                </div>
                                <div class="form-group">
                                    <input type="text" id="registerUsername" placeholder="Username" required>
                                </div>
                                <div class="form-group">
                                    <input type="email" id="registerEmail" placeholder="Email" required>
                                </div>
                                <div class="form-group">
                                    <input type="password" id="registerPassword" placeholder="Password" required>
                                    <div class="password-requirements">
                                        Password must contain at least 8 characters, including uppercase, lowercase, and numbers
                                    </div>
                                </div>
                                <button type="submit">Register</button>
                                <div class="switch-view">
                                    Already have an account? <a href="#" id="showLogin">Login</a>
                                </div>
                            </form>

                            <div id="error" class="error"></div>
                        </div>
                    `}
                </div>
                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    const loginForm = document.getElementById('loginForm');
                    const registerForm = document.getElementById('registerForm');
                    const errorDiv = document.getElementById('error');
                    const showRegister = document.getElementById('showRegister');
                    const showLogin = document.getElementById('showLogin');
                    const logoutButton = document.getElementById('logoutButton');

                    // Form submissions
                    loginForm.addEventListener('submit', (e) => {
                        e.preventDefault();
                        vscode.postMessage({
                            type: 'login',
                            username: document.getElementById('loginUsername').value,
                            password: document.getElementById('loginPassword').value
                        });
                    });

                    registerForm.addEventListener('submit', (e) => {
                        e.preventDefault();
                        vscode.postMessage({
                            type: 'register',
                            username: document.getElementById('registerUsername').value,
                            email: document.getElementById('registerEmail').value,
                            password: document.getElementById('registerPassword').value
                        });
                    });

                    // View switching
                    showRegister.addEventListener('click', (e) => {
                        e.preventDefault();
                        vscode.postMessage({ type: 'viewChange', view: 'register' });
                    });

                    showLogin.addEventListener('click', (e) => {
                        e.preventDefault();
                        vscode.postMessage({ type: 'viewChange', view: 'login' });
                    });

                    // Only handle errors in JS
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'error') {
                            errorDiv.textContent = message.message;
                        }
                    });

                    // Handle repository status updates
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'repoStatus') {
                            const repoStatusEl = document.getElementById('repoStatus');
                            if (!repoStatusEl) return;
                            
                            if (message.status.hasRemote) {
                                repoStatusEl.innerHTML = \`
                                    <p>📁 Project: <a href="\${message.status.projectUrl}" target="_blank" title="Open in GitLab">\${message.status.projectName}</a></p>
                                    <button class="sync-button" onclick="vscode.postMessage({command: 'sync'})">
                                        Sync Changes
                                    </button>
                                \`;
                            } else {
                                repoStatusEl.innerHTML = '<p>No remote repository connected</p>';
                            }
                        }
                    });

                    if (logoutButton) {
                        logoutButton.addEventListener('click', () => {
                            vscode.postMessage({ type: 'logout' });
                        });
                    }
                </script>
            </body>
            </html>`;
    }

    public dispose() {
        if (this._view) {
            this._view = undefined;
        }
    }
} 