import * as vscode from "vscode";
import { GlobalState, AuthState, GitLabInfo, GitLabCredentials } from "../types/state";

export const initialState: GlobalState = {
    auth: {
        isAuthenticated: false,
        connectionStatus: "disconnected",
        currentView: "login",
        gitlabInfo: undefined,
        gitlabCredentials: undefined,
        lastSyncTimestamp: undefined,
    },
    syncLock: {
        isLocked: false,
        timestamp: 0,
    },
};

export class StateManager {
    private static instance: StateManager;
    private state: GlobalState;
    private readonly stateKey = "frontier.globalState";

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
            throw new Error("StateManager not initialized");
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
            ...update,
        };
        await this.persistState();
        this.notifyStateChange();
    }

    async updateGitLabCredentials(credentials: GitLabCredentials | undefined): Promise<void> {
        await this.updateAuthState({
            gitlabCredentials: credentials,
        });
    }

    async updateGitLabInfo(info: GitLabInfo | undefined): Promise<void> {
        await this.updateAuthState({
            gitlabInfo: info,
        });
    }

    async updateLastSyncTimestamp(): Promise<void> {
        await this.updateAuthState({
            lastSyncTimestamp: Date.now(),
        });
    }

    getGitLabCredentials(): GitLabCredentials | undefined {
        return this.state.auth.gitlabCredentials;
    }

    getGitLabInfo(): GitLabInfo | undefined {
        return this.state.auth.gitlabInfo;
    }

    // Sync lock methods
    async acquireSyncLock(): Promise<boolean> {
        // Check if lock is already held
        if (this.state.syncLock?.isLocked) {
            // Check if lock is stale (older than 5 minutes)
            const now = Date.now();
            const lockTime = this.state.syncLock.timestamp;
            const fiveMinutesInMs = 5 * 60 * 1000;

            if (now - lockTime > fiveMinutesInMs) {
                // Lock is stale, force release it
                console.log("Stale sync lock detected, releasing it");
                await this.releaseSyncLock();
            } else {
                console.log("Sync already in progress, cannot acquire lock");
                return false;
            }
        }

        // Acquire the lock
        this.state.syncLock = {
            isLocked: true,
            timestamp: Date.now(),
        };
        await this.persistState();
        this.notifyStateChange();
        console.log("Sync lock acquired");
        return true;
    }

    async releaseSyncLock(): Promise<void> {
        if (this.state.syncLock) {
            this.state.syncLock.isLocked = false;
            this.state.syncLock.timestamp = Date.now();
            await this.persistState();
            this.notifyStateChange();
            console.log("Sync lock released");
        }
    }

    isSyncLocked(): boolean {
        return this.state.syncLock?.isLocked === true;
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
