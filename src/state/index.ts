import * as vscode from "vscode";
import { GlobalState, AuthState, GitLabInfo, GitLabCredentials } from "../types/state";
import * as fs from "fs";
import * as path from "path";

export const initialState: GlobalState = {
    auth: {
        isAuthenticated: false,
        connectionStatus: "disconnected",
        currentView: "login",
        gitlabInfo: undefined,
        gitlabCredentials: undefined,
        lastSyncTimestamp: undefined,
    },
};

export class StateManager {
    private static instance: StateManager;
    private state: GlobalState;
    private readonly stateKey = "frontier.globalState";
    private lockFilePath: string | undefined;

    private constructor(private context: vscode.ExtensionContext) {
        // Initialize with stored state or defaults
        const storedState = this.context.globalState.get<GlobalState>(this.stateKey);
        this.state = storedState || initialState;

        // Clean up any stale lock files on initialization
        this.cleanupStaleLockFiles();
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
        // Get workspace folder for lock file
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log("No workspace folder found, cannot create lock file");
            return false;
        }

        // Create lock file path in .git directory
        const gitDir = path.join(workspaceFolders[0].uri.fsPath, ".git");
        this.lockFilePath = path.join(gitDir, "frontier-sync.lock");

        try {
            // Try to create the lock file
            await fs.promises.writeFile(this.lockFilePath, Date.now().toString(), { flag: "wx" });
            console.log("Sync lock acquired");
            return true;
        } catch (error) {
            // Check if lock is stale (older than 5 minutes)
            try {
                const lockContent = await fs.promises.readFile(this.lockFilePath, "utf8");
                const lockTime = parseInt(lockContent);
                const now = Date.now();
                const fiveMinutesInMs = 5 * 60 * 1000;

                if (now - lockTime > fiveMinutesInMs) {
                    // Lock is stale, force release it
                    console.log("Stale sync lock detected, releasing it");
                    await this.releaseSyncLock();
                    // Try to acquire lock again
                    return this.acquireSyncLock();
                }
            } catch (readError) {
                console.log("Error reading lock file:", readError);
            }

            console.log("Sync already in progress, cannot acquire lock");
            return false;
        }
    }

    async releaseSyncLock(): Promise<void> {
        if (this.lockFilePath) {
            try {
                // Remove the lock file
                await fs.promises.unlink(this.lockFilePath);
                this.lockFilePath = undefined;
                console.log("Sync lock released");
            } catch (error) {
                console.log("Error releasing sync lock:", error);
            }
        }
    }

    isSyncLocked(): boolean {
        return this.lockFilePath !== undefined;
    }

    private readonly stateChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeState = this.stateChangeEmitter.event;

    private notifyStateChange(): void {
        this.stateChangeEmitter.fire();
    }

    private async cleanupStaleLockFiles(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const gitDir = path.join(workspaceFolders[0].uri.fsPath, ".git");
        const lockFilePath = path.join(gitDir, "frontier-sync.lock");

        try {
            // Check if lock file exists
            await fs.promises.access(lockFilePath);

            // Read lock file content
            const lockContent = await fs.promises.readFile(lockFilePath, "utf8");
            const lockTime = parseInt(lockContent);
            const now = Date.now();
            const fiveMinutesInMs = 5 * 60 * 1000;

            // If lock is stale (older than 5 minutes), remove it
            if (now - lockTime > fiveMinutesInMs) {
                console.log("Cleaning up stale lock file during initialization");
                await fs.promises.unlink(lockFilePath);
            }
        } catch (error) {
            // File doesn't exist or can't be accessed, which is fine
            // We don't need to do anything in this case
        }
    }

    dispose(): void {
        this.stateChangeEmitter.dispose();
    }
}
