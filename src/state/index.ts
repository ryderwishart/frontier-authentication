import * as vscode from "vscode";
import { GlobalState, AuthState, GitLabInfo, GitLabCredentials, UserInfo, MediaFilesStrategy } from "../types/state";
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
    private hasAcquiredLock: boolean = false;
    private isPidAlive(pid: number): boolean {
        try {
            // Signal 0 checks for existence without killing the process
            process.kill(pid, 0);
            return true;
        } catch (err: any) {
            if (err && (err.code === "ESRCH" || err.code === "ENOENT")) {
                return false; // no such process
            }
            // EPERM or others mean it exists but we don't have permission
            return true;
        }
    }

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

    getUserInfo(): UserInfo | undefined {
        return this.state.auth.userInfo;
    }

    // ========== Media Strategy per repository ==========
    getRepoStrategy(workspacePath: string): MediaFilesStrategy | undefined {
        return this.state.repoStrategies?.[workspacePath];
    }

    async setRepoStrategy(workspacePath: string, strategy: MediaFilesStrategy): Promise<void> {
        const existing = this.state.repoStrategies || {};
        this.state.repoStrategies = { ...existing, [workspacePath]: strategy };
        await this.persistState();
        this.notifyStateChange();
    }

    // Sync lock methods
    async acquireSyncLock(workspacePath: string | undefined): Promise<boolean> {
        // Get workspace folder for lock file
        if (!workspacePath) {
            workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                console.log("No workspace folder found, cannot create lock file");
                return false;
            }
        }
        // Create lock file path in .git directory (do not mark acquired yet)
        const gitDir = path.join(workspacePath, ".git");
        const lockPath = path.join(gitDir, "frontier-sync.lock");

        try {
            // Try to create the lock file
            const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
            await fs.promises.writeFile(lockPath, payload, { flag: "wx" });
            // Only now mark the lock as acquired and record the path
            this.lockFilePath = lockPath;
            this.hasAcquiredLock = true;
            console.log("Sync lock acquired");
            return true;
        } catch (error) {
            // Check if lock is stale (older than 5 minutes)
            try {
                const lockContent = await fs.promises.readFile(lockPath, "utf8");
                let lockTime: number | undefined;
                let lockPid: number | undefined;
                try {
                    const parsed = JSON.parse(lockContent);
                    lockTime = typeof parsed.timestamp === "number" ? parsed.timestamp : undefined;
                    lockPid = typeof parsed.pid === "number" ? parsed.pid : undefined;
                } catch {
                    // Legacy format: content is just the timestamp
                    const legacy = parseInt(lockContent);
                    lockTime = isNaN(legacy) ? undefined : legacy;
                }
                const now = Date.now();
                const fiveMinutesInMs = 5 * 60 * 1000;

                const isStale = typeof lockTime === "number" && now - lockTime > fiveMinutesInMs;
                const ownerGone = typeof lockPid === "number" ? !this.isPidAlive(lockPid) : false;
                const legacyAndStale = (typeof lockPid !== "number") && isStale;

                if (ownerGone || legacyAndStale) {
                    // Lock is stale, force release it
                    console.log(
                        ownerGone
                            ? "Orphaned sync lock detected (owner process gone), releasing it"
                            : "Legacy stale sync lock detected, releasing it"
                    );
                    // Directly remove stale file (we don't own an acquired lock here)
                    try {
                        await fs.promises.unlink(lockPath);
                    } catch (unlinkErr) {
                        console.log("Error removing stale lock file:", unlinkErr);
                    }
                    // Try to acquire lock again
                    return this.acquireSyncLock(workspacePath);
                }
            } catch (readError) {
                console.log("Error reading lock file:", readError);
            }

            console.log("Sync already in progress, cannot acquire lock");
            this.hasAcquiredLock = false;
            return false;
        }
    }

    async releaseSyncLock(): Promise<void> {
        if (this.hasAcquiredLock && this.lockFilePath) {
            try {
                // Remove the lock file
                await fs.promises.unlink(this.lockFilePath);
                console.log("Sync lock released");
            } catch (error: any) {
                if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
                    // File already removed externally; treat as released
                    console.log("Lock file already removed; clearing in-memory lock state");
                } else {
                    console.log("Error releasing sync lock:", error);
                    // For non-ENOENT errors, still clear in-memory lock to avoid wedging the session
                }
            } finally {
                this.lockFilePath = undefined;
                this.hasAcquiredLock = false;
            }
        }
    }

    isSyncLocked(): boolean {
        return this.hasAcquiredLock === true;
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
            let lockTime: number | undefined;
            let lockPid: number | undefined;
            try {
                const parsed = JSON.parse(lockContent);
                lockTime = typeof parsed.timestamp === "number" ? parsed.timestamp : undefined;
                lockPid = typeof parsed.pid === "number" ? parsed.pid : undefined;
            } catch {
                const legacy = parseInt(lockContent);
                lockTime = isNaN(legacy) ? undefined : legacy;
            }
            const now = Date.now();
            const fiveMinutesInMs = 5 * 60 * 1000;

            // If lock is orphaned or legacy-stale, remove it
            const isStale = typeof lockTime === "number" && now - lockTime > fiveMinutesInMs;
            const ownerGone = typeof lockPid === "number" ? !this.isPidAlive(lockPid) : false;
            const legacyAndStale = (typeof lockPid !== "number") && isStale;
            if (ownerGone || legacyAndStale) {
                console.log(
                    ownerGone
                        ? "Cleaning up orphaned lock file during initialization (owner process gone)"
                        : "Cleaning up legacy stale lock file during initialization"
                );
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
