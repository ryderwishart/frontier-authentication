import * as vscode from 'vscode';
import { GlobalState, AuthState, GitLabInfo, GitLabCredentials } from '../types/state';

export const initialState: GlobalState = {
    auth: {
        isAuthenticated: false,
        connectionStatus: 'disconnected',
        currentView: 'login',
        gitlabInfo: undefined,
        gitlabCredentials: undefined,
        lastSyncTimestamp: undefined
    }
};

export class StateManager {
    private static instance: StateManager;
    private state: GlobalState;
    private readonly stateKey = 'frontier.globalState';

    private constructor(private context: vscode.ExtensionContext) {
        // Initialize with stored state or defaults
        const storedState = this.context.globalState.get<GlobalState>(this.stateKey);
        this.state = storedState || initialState;
    }

    static initialize(context: vscode.ExtensionContext): StateManager {
        if (!StateManager.instance) {
            StateManager.instance = new StateManager(context);
        }
        return StateManager.instance;
    }

    static getInstance(): StateManager {
        if (!StateManager.instance) {
            throw new Error('StateManager not initialized');
        }
        return StateManager.instance;
    }

    private async persistState(): Promise<void> {
        await this.context.globalState.update(this.stateKey, this.state);
    }

    getAuthState(): AuthState {
        return { ...this.state.auth };
    }

    async updateAuthState(update: Partial<AuthState>): Promise<void> {
        this.state.auth = {
            ...this.state.auth,
            ...update
        };
        await this.persistState();
        this.notifyStateChange();
    }

    async updateGitLabCredentials(credentials: GitLabCredentials | undefined): Promise<void> {
        await this.updateAuthState({
            gitlabCredentials: credentials
        });
    }

    async updateGitLabInfo(info: GitLabInfo | undefined): Promise<void> {
        await this.updateAuthState({
            gitlabInfo: info
        });
    }

    async updateLastSyncTimestamp(): Promise<void> {
        await this.updateAuthState({
            lastSyncTimestamp: Date.now()
        });
    }

    getGitLabCredentials(): GitLabCredentials | undefined {
        return this.state.auth.gitlabCredentials;
    }

    getGitLabInfo(): GitLabInfo | undefined {
        return this.state.auth.gitlabInfo;
    }

    private readonly stateChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeState = this.stateChangeEmitter.event;

    private notifyStateChange(): void {
        this.stateChangeEmitter.fire();
    }

    dispose(): void {
        this.stateChangeEmitter.dispose();
    }
} 