import * as vscode from 'vscode';
import { GlobalState, AuthState } from '../types/state';

export class StateManager {
    private static instance: StateManager;
    private state: GlobalState;
    private readonly stateKey = 'frontier.globalState';

    private constructor(private context: vscode.ExtensionContext) {
        // Initialize with stored state or defaults
        const storedState = this.context.globalState.get<GlobalState>(this.stateKey);
        this.state = storedState || {
            auth: {
                isAuthenticated: false,
                connectionStatus: 'disconnected',
                currentView: 'login'
            }
        };
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

    private readonly stateChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeState = this.stateChangeEmitter.event;

    private notifyStateChange(): void {
        this.stateChangeEmitter.fire();
    }

    dispose(): void {
        this.stateChangeEmitter.dispose();
    }
} 