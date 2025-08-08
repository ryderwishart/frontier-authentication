import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";
import crypto from "crypto";

import { StateManager } from "../state";

export interface ConflictedFile {
    filepath: string;
    ours: string;
    theirs: string;
    base: string;
    isNew?: boolean;
    isDeleted?: boolean;
}

export interface SyncResult {
    hadConflicts: boolean;
    conflicts?: ConflictedFile[];
    offline?: boolean;
}

export enum RemoteBranchStatus {
    FOUND,
    NOT_FOUND,
    ERROR,
}

export class GitService {
    private stateManager: StateManager;
    private debugLogging: boolean = false;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
        // Check VS Code configuration for debug logging setting
        this.debugLogging = vscode.workspace
            .getConfiguration("frontier")
            .get("debugGitLogging", false);
    }

    /**
     * Enable or disable debug logging for git operations
     */
    setDebugLogging(enabled: boolean): void {
        this.debugLogging = enabled;
    }

    /**
     * Conditional debug logging - only logs if debug logging is enabled
     */
    private debugLog(message: string, data?: any): void {
        if (this.debugLogging) {
            if (data !== undefined) {
                console.log(message, JSON.stringify(data));
            } else {
                console.log(message);
            }
        }
    }

    /**
     * Wraps git operations with a timeout to prevent hanging indefinitely
     */
    private async withTimeout<T>(
        operation: Promise<T>,
        timeoutMs: number = 2 * 60 * 1000, // 2 minutes
        operationName: string = "Git operation"
    ): Promise<T> {
        const startTime = Date.now();
        console.log(`[GitService] Starting ${operationName} with ${timeoutMs}ms timeout`);

        const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        try {
            const result = await Promise.race([operation, timeout]);
            const duration = Date.now() - startTime;
            console.log(`[GitService] ${operationName} completed successfully in ${duration}ms`);
            return result as T;
        } catch (error) {
            const duration = Date.now() - startTime;

            if (error instanceof Error && error.message.includes("timed out")) {
                console.error(
                    `[GitService] TIMEOUT: ${operationName} timed out after ${duration}ms`
                );
                console.error(`[GitService] Timeout diagnostic info:`, {
                    operation: operationName,
                    timeoutMs,
                    actualDuration: duration,
                    timestamp: new Date().toISOString(),
                    possibleCauses: [
                        "Network connectivity issues",
                        "Remote server unresponsive",
                        "Firewall/proxy blocking connection",
                        "Large repository data transfer",
                        "Authentication server delays",
                    ],
                });

                // Add network connectivity check
                this.logNetworkDiagnostics();

                throw new Error(
                    `${operationName} failed: Network timeout after ${duration}ms. Please check your connection and try again.`
                );
            }

            // Log other errors with more context
            console.error(`[GitService] ${operationName} failed after ${duration}ms:`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                operation: operationName,
                duration,
                timestamp: new Date().toISOString(),
            });

            throw error;
        }
    }

    /**
     * Logs network diagnostic information to help debug connectivity issues
     */
    private async logNetworkDiagnostics(): Promise<void> {
        console.log(`[GitService] Running network diagnostics...`);

        const diagnostics = {
            timestamp: new Date().toISOString(),
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "N/A",
            onlineStatus: typeof navigator !== "undefined" ? (navigator as any).onLine : "Unknown",
            connectionTests: {} as Record<
                string,
                { status: string; responseTime?: number; httpStatus?: number; error?: string }
            >,
        };

        // Test basic connectivity
        const testEndpoints = [
            { name: "GitLab", url: "https://gitlab.com", timeout: 5000 },
            { name: "Frontier API", url: "https://api.frontierrnd.com", timeout: 5000 },
            { name: "Google DNS", url: "https://8.8.8.8", timeout: 3000 },
        ];

        for (const endpoint of testEndpoints) {
            try {
                const startTime = Date.now();
                const response = await Promise.race([
                    fetch(endpoint.url, { method: "HEAD", cache: "no-store" }),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error("timeout")), endpoint.timeout)
                    ),
                ]);
                const duration = Date.now() - startTime;

                diagnostics.connectionTests[endpoint.name] = {
                    status: "success",
                    responseTime: duration,
                    httpStatus: (response as Response).status,
                };
            } catch (error) {
                diagnostics.connectionTests[endpoint.name] = {
                    status: "failed",
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }

        console.error(`[GitService] Network diagnostics:`, diagnostics);
    }

    /**
     * Safe push operation with timeout and retry logic
     */
    private async safePush(
        dir: string,
        auth: { username: string; password: string },
        options?: { force?: boolean; ref?: string; timeoutMs?: number }
    ): Promise<void> {
        const { force = false, ref, timeoutMs = 2 * 60 * 1000 } = options || {};

        console.log(`[GitService] Starting push operation:`, {
            directory: dir,
            ref: ref || "HEAD",
            force,
            timeoutMs,
            timestamp: new Date().toISOString(),
        });

        // Get some context before pushing
        try {
            const currentBranch = await git.currentBranch({ fs, dir });
            const remoteUrl = await this.getRemoteUrl(dir);
            const status = await git.statusMatrix({ fs, dir });
            const changedFiles = status.filter(
                (entry) => entry[1] !== entry[2] || entry[2] !== entry[3]
            ).length;

            console.log(`[GitService] Push context:`, {
                currentBranch,
                remoteUrl,
                changedFiles,
                hasAuth: !!auth.username,
            });
        } catch (contextError) {
            console.warn(`[GitService] Could not gather push context:`, contextError);
        }

        const pushOperation = git.push({
            fs,
            http,
            dir,
            remote: "origin",
            ...(ref && { ref }),
            onAuth: () => {
                console.log(`[GitService] Authentication requested for push operation`);
                return auth;
            },
            ...(force && { force }),
        });

        try {
            await this.withTimeout(pushOperation, timeoutMs, "Push operation");
            console.log(`[GitService] Push completed successfully`);
        } catch (error) {
            console.error(`[GitService] Push operation failed:`, {
                error: error instanceof Error ? error.message : String(error),
                directory: dir,
                ref: ref || "HEAD",
                force,
                timestamp: new Date().toISOString(),
            });
            throw error;
        }
    }

    // Below is a simplified version. It commits if dirty, fetches remote changes, tries pulling (which will error on merge conflicts), and then either pushes or returns a list of files that differ.
    async syncChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string },
        options?: { commitMessage?: string }
    ): Promise<SyncResult> {
        // Check if sync is already in progress
        if (this.stateManager.isSyncLocked()) {
            console.log("Sync already in progress, skipping this request");
            return { hadConflicts: false };
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock(dir);
        if (!lockAcquired) {
            console.log("Failed to acquire sync lock, skipping this request");
            return { hadConflicts: false };
        }

        try {
            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // 1. Commit local changes if needed
            const { isDirty, status: workingCopyStatusBeforeCommit } =
                await this.getWorkingCopyState(dir);
            if (isDirty) {
                console.log("Working copy is dirty, committing local changes (LFS-aware)");
                await this.addAllWithLFS(dir, auth);
                await this.commit(dir, options?.commitMessage || "Local changes", author);
            }

            // 2. Check if we're online
            if (!(await this.isOnline())) {
                return { hadConflicts: false, offline: true };
            }

            // 3. Fetch remote changes to get latest state
            console.log("[GitService] Fetching remote changes");
            try {
                await this.withTimeout(
                    git.fetch({
                        fs,
                        http,
                        dir,
                        onAuth: () => {
                            console.log(
                                "[GitService] Authentication requested for fetch operation"
                            );
                            return auth;
                        },
                    }),
                    2 * 60 * 1000,
                    "Fetch operation"
                );
                console.log("[GitService] Fetch completed successfully");
            } catch (fetchError) {
                console.error("[GitService] Fetch operation failed:", {
                    error: fetchError instanceof Error ? fetchError.message : String(fetchError),
                    directory: dir,
                    hasAuth: !!auth.username,
                    timestamp: new Date().toISOString(),
                });
                throw fetchError;
            }

            // 4. Get references to current state
            const localHead = await git.resolveRef({ fs, dir, ref: "HEAD" });
            let remoteHead;
            const remoteRef = `refs/remotes/origin/${currentBranch}`;

            // 5. Check if remote branch exists
            try {
                remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });
            } catch (err) {
                // Remote branch doesn't exist, just push our changes
                console.log("Remote branch doesn't exist, pushing our changes");
                await this.safePush(dir, auth);
                return { hadConflicts: false };
            }

            // Get files changed in local HEAD (this doesn't need updating after refetch)
            const localStatusMatrix = await git.statusMatrix({ fs, dir });

            this.debugLog("workingCopyStatusBeforeCommit:", workingCopyStatusBeforeCommit);
            this.debugLog("localStatusMatrix:", localStatusMatrix);

            // 6. If local and remote are identical, nothing to do
            if (localHead === remoteHead) {
                console.log("Local and remote are already in sync");
                return { hadConflicts: false };
            }

            // 7. Try fast-forward first (simplest case)
            try {
                console.log("[GitService] Attempting fast-forward merge");
                console.log("[GitService] Fast-forward context:", {
                    localHead: localHead.substring(0, 8),
                    remoteHead: remoteHead.substring(0, 8),
                    currentBranch,
                    directory: dir,
                });

                await this.withTimeout(
                    git.fastForward({
                        fs,
                        http,
                        dir,
                        ref: currentBranch,
                        onAuth: () => {
                            console.log("[GitService] Authentication requested for fast-forward");
                            return auth;
                        },
                    }),
                    2 * 60 * 1000,
                    "Fast-forward operation"
                );

                // Fast-forward worked, push any local changes
                console.log("[GitService] Fast-forward successful, pushing any local changes");
                await this.safePush(dir, auth);

                return { hadConflicts: false };
            } catch (err) {
                console.log("[GitService] Fast-forward failed, analyzing conflicts:", {
                    error: err instanceof Error ? err.message : String(err),
                    localHead: localHead.substring(0, 8),
                    remoteHead: remoteHead.substring(0, 8),
                });
            }

            // 8. If we get here, we have divergent histories - check for conflicts
            console.log("Fast-forward failed, need to handle conflicts");

            // Refetch to ensure we have the absolute latest remote state before analyzing conflicts
            console.log("[GitService] Refetching remote changes before conflict analysis");
            try {
                await this.withTimeout(
                    git.fetch({
                        fs,
                        http,
                        dir,
                        onAuth: () => {
                            console.log(
                                "[GitService] Authentication requested for pre-conflict-analysis fetch"
                            );
                            return auth;
                        },
                    }),
                    2 * 60 * 1000,
                    "Pre-conflict-analysis fetch"
                );
                console.log("[GitService] Pre-conflict-analysis fetch completed successfully");

                // Update remoteHead reference after the new fetch
                remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });
                console.log(
                    "[GitService] Updated remote HEAD after refetch:",
                    remoteHead.substring(0, 8)
                );
            } catch (fetchError) {
                console.error("[GitService] Pre-conflict-analysis fetch failed:", {
                    error: fetchError instanceof Error ? fetchError.message : String(fetchError),
                    directory: dir,
                    hasAuth: !!auth.username,
                    timestamp: new Date().toISOString(),
                });
                // Continue with conflict analysis using the potentially stale remote state
                console.warn(
                    "[GitService] Continuing with conflict analysis using potentially stale remote state"
                );
            }

            // Recalculate merge base after potential refetch
            const updatedMergeBaseCommits = await git.findMergeBase({
                fs,
                dir,
                oids: [localHead, remoteHead],
            });

            this.debugLog("Updated merge base commits after refetch:", updatedMergeBaseCommits);

            // Update status matrices with potentially new remote state
            const updatedRemoteStatusMatrix = await git.statusMatrix({
                fs,
                dir,
                ref: remoteRef,
            });
            const updatedMergeBaseStatusMatrix =
                updatedMergeBaseCommits.length > 0
                    ? await git.statusMatrix({
                          fs,
                          dir,
                          ref: updatedMergeBaseCommits[0],
                      })
                    : [];

            this.debugLog("updatedRemoteStatusMatrix:", updatedRemoteStatusMatrix);
            this.debugLog("updatedMergeBaseStatusMatrix:", updatedMergeBaseStatusMatrix);

            // Convert status matrices to maps for easier lookup
            const localStatusMap = new Map(
                localStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const remoteStatusMap = new Map(
                updatedRemoteStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const mergeBaseStatusMap = new Map(
                updatedMergeBaseStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );

            // Get all unique filepaths across all three references
            const allFilepaths = new Set([
                ...localStatusMap.keys(),
                ...remoteStatusMap.keys(),
                ...mergeBaseStatusMap.keys(),
            ]);

            // Arrays to store categorized files
            const filesAddedLocally: string[] = [];
            const filesAddedOnRemote: string[] = [];
            const filesDeletedLocally: string[] = [];
            const filesDeletedOnRemote: string[] = [];
            const filesModifiedAndTreatedAsPotentialConflict: string[] = [];

            // Analyze each file's status across all references
            for (const filepath of allFilepaths) {
                const localStatus = localStatusMap.get(filepath);
                const remoteStatus = remoteStatusMap.get(filepath);
                const mergeBaseStatus = mergeBaseStatusMap.get(filepath);

                // File exists in remote but not in local or merge base -> added on remote
                if (
                    remoteStatus &&
                    (remoteStatus as any)[0] === 1 &&
                    (!localStatus || (localStatus as any)[0] === 0) &&
                    (!mergeBaseStatus || (mergeBaseStatus as any)[0] === 0)
                ) {
                    filesAddedOnRemote.push(filepath);
                    continue;
                }

                // File exists in local but not in remote or merge base -> added locally
                if (
                    localStatus &&
                    (localStatus as any)[0] === 1 &&
                    (!remoteStatus || (remoteStatus as any)[0] === 0) &&
                    (!mergeBaseStatus || (mergeBaseStatus as any)[0] === 0)
                ) {
                    filesAddedLocally.push(filepath);
                    continue;
                }

                // File exists in merge base and local but not in remote -> deleted on remote
                if (
                    mergeBaseStatus &&
                    (mergeBaseStatus as any)[0] === 1 &&
                    localStatus &&
                    (localStatus as any)[0] === 1 &&
                    (!remoteStatus || (remoteStatus as any)[0] === 0)
                ) {
                    filesDeletedOnRemote.push(filepath);
                    continue;
                }

                // File exists in merge base and remote but not in local -> deleted locally
                if (
                    mergeBaseStatus &&
                    (mergeBaseStatus as any)[0] === 1 &&
                    remoteStatus &&
                    (remoteStatus as any)[0] === 1 &&
                    (!localStatus || (localStatus as any)[0] === 0)
                ) {
                    filesDeletedLocally.push(filepath);
                    continue;
                }

                // File exists in all three but has different content
                if (
                    localStatus &&
                    (localStatus as any)[0] === 1 &&
                    remoteStatus &&
                    (remoteStatus as any)[0] === 1 &&
                    mergeBaseStatus &&
                    (mergeBaseStatus as any)[0] === 1
                ) {
                    const localModified = (localStatus as any)[1] === 2; // workdir different from HEAD
                    const remoteModified = (remoteStatus as any)[1] === 2; // workdir different from HEAD
                    const mergeBaseModified = (mergeBaseStatus as any)[1] === 2; // merge base different from HEAD

                    // Treat all modified files as potential conflicts for simplicity
                    if (localModified || remoteModified || mergeBaseModified) {
                        filesModifiedAndTreatedAsPotentialConflict.push(filepath);
                    }
                }
            }

            this.debugLog("Files added locally:", filesAddedLocally);
            this.debugLog("Files deleted locally:", filesDeletedLocally);
            this.debugLog("Files added on remote:", filesAddedOnRemote);
            this.debugLog("Files deleted on remote:", filesDeletedOnRemote);
            this.debugLog(
                "Files modified and treated as potential conflict:",
                filesModifiedAndTreatedAsPotentialConflict
            );

            // All changed files for comprehensive conflict detection
            const allChangedFilePaths = [
                ...new Set([
                    ...filesAddedLocally,
                    ...filesModifiedAndTreatedAsPotentialConflict,
                    ...filesDeletedLocally,
                    ...filesAddedOnRemote,
                    ...filesDeletedOnRemote,
                ]),
            ];

            this.debugLog("All changed files:", allChangedFilePaths);

            // 9. Get all files changed in either branch with enhanced conflict detection
            const conflicts = await Promise.all(
                allChangedFilePaths.map(async (filepath) => {
                    let localContent = "";
                    let remoteContent = "";
                    let baseContent = "";
                    let isNew = false;
                    let isDeleted = false;

                    // More precise determination of file status
                    const isAddedLocally = filesAddedLocally.includes(filepath);
                    const isAddedRemotely = filesAddedOnRemote.includes(filepath);
                    const isDeletedLocally = filesDeletedLocally.includes(filepath);
                    const isDeletedRemotely = filesDeletedOnRemote.includes(filepath);

                    // Determine if this is a new file (added on either side)
                    isNew = isAddedLocally || isAddedRemotely;

                    // Determine if this should be considered deleted
                    isDeleted =
                        (isDeletedLocally && !isAddedRemotely) ||
                        (isDeletedRemotely && !isAddedLocally);

                    // Try to read local content if it exists in local HEAD
                    try {
                        if (!isDeletedLocally && !isAddedLocally) {
                            const { blob: lBlob } = await git.readBlob({
                                fs,
                                dir,
                                oid: localHead,
                                filepath,
                            });
                            localContent = new TextDecoder().decode(lBlob);
                        } else if (isAddedLocally) {
                            // For locally added files, read from working directory
                            try {
                                const fileContent = await fs.promises.readFile(
                                    path.join(dir, filepath),
                                    "utf8"
                                );
                                localContent = fileContent;
                            } catch (e) {
                                this.debugLog(`Error reading locally added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in local HEAD`);
                    }

                    // Try to read remote content if it exists in remote HEAD
                    try {
                        if (!isDeletedRemotely && !isAddedRemotely) {
                            const { blob: rBlob } = await git.readBlob({
                                fs,
                                dir,
                                oid: remoteHead,
                                filepath,
                            });
                            remoteContent = new TextDecoder().decode(rBlob);
                        } else if (isAddedRemotely) {
                            try {
                                const { blob: rBlob } = await git.readBlob({
                                    fs,
                                    dir,
                                    oid: remoteHead,
                                    filepath,
                                });
                                remoteContent = new TextDecoder().decode(rBlob);
                            } catch (e) {
                                this.debugLog(`Error reading remotely added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in remote HEAD`);
                    }

                    // Try to read base content if available
                    try {
                        if (updatedMergeBaseCommits.length > 0) {
                            const { blob: bBlob } = await git.readBlob({
                                fs,
                                dir,
                                oid: updatedMergeBaseCommits[0],
                                filepath,
                            });
                            baseContent = new TextDecoder().decode(bBlob);
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in merge base`);
                    }

                    // Special conflict cases handling
                    let isConflict = false;

                    // Case 1: File modified in both branches
                    if (filesModifiedAndTreatedAsPotentialConflict.includes(filepath)) {
                        isConflict = true;
                    }
                    // Case 2: Content differs between branches and at least one differs from base
                    else if (
                        localContent !== remoteContent &&
                        (localContent !== baseContent || remoteContent !== baseContent)
                    ) {
                        isConflict = true;
                    }
                    // Case 3: Added in both branches with different content
                    else if (isAddedLocally && isAddedRemotely && localContent !== remoteContent) {
                        isConflict = true;
                    }
                    // Case 4: Modified locally but deleted remotely
                    else if (
                        !isDeletedLocally &&
                        isDeletedRemotely &&
                        localContent !== baseContent
                    ) {
                        isConflict = true;
                    }
                    // Case 5: Modified remotely but deleted locally
                    else if (
                        isDeletedLocally &&
                        !isDeletedRemotely &&
                        remoteContent !== baseContent
                    ) {
                        isConflict = true;
                    }

                    if (isConflict) {
                        return {
                            filepath,
                            ours: localContent,
                            theirs: remoteContent,
                            base: baseContent,
                            isNew,
                            isDeleted,
                        };
                    }
                    return null;
                })
            ).then((results) =>
                results.filter(
                    (
                        result
                    ): result is {
                        filepath: string;
                        ours: string;
                        theirs: string;
                        base: string;
                        isNew: boolean;
                        isDeleted: boolean;
                    } => result !== null
                )
            );

            console.log(`Found ${conflicts.length} conflicts that need resolution`);
            return { hadConflicts: true, conflicts };
        } catch (err) {
            // Enhanced error logging for sync operations
            console.error(`[GitService] Sync operation failed:`, {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                directory: dir,
                author: author.name,
                timestamp: new Date().toISOString(),
            });

            // Log additional context that might help with debugging
            try {
                const currentBranch = await git.currentBranch({ fs, dir });
                const remoteUrl = await this.getRemoteUrl(dir);
                const status = await git.statusMatrix({ fs, dir });

                console.error(`[GitService] Sync failure context:`, {
                    currentBranch,
                    remoteUrl,
                    statusMatrixSize: status.length,
                    dirtyFiles: status.filter(
                        (entry) => entry[1] !== entry[2] || entry[2] !== entry[3]
                    ).length,
                });
            } catch (contextError) {
                console.warn(`[GitService] Could not gather sync failure context:`, contextError);
            }

            throw err;
        } finally {
            // Always release the lock when done, regardless of success or failure
            await this.stateManager.releaseSyncLock();
        }
    }

    /**
     * Helper functions to identify file status from git status matrix
     * Each entry in status matrix is [filepath, head, workdir, stage]
     * - head: file exists in HEAD commit (1) or not (0)
     * - workdir: file is absent (0), identical to HEAD (1), or different from HEAD (2)
     * - stage: file is absent (0), identical to HEAD (1), identical to WORKDIR (2), or different from WORKDIR (3)
     */
    private fileStatus = {
        isNew: ([_, head, workdir]: [string, number, number, number]): boolean =>
            head === 0 && workdir === 1,

        isModified: ([_, head, workdir, stage]: [string, number, number, number]): boolean =>
            (head === 1 && workdir === 2) || // Modified compared to HEAD
            (head === 1 && workdir === 1 && workdir !== stage), // Same as HEAD but different in stage

        isDeleted: ([_, head, workdir]: [string, number, number, number]): boolean =>
            head === 1 && workdir === 0,

        hasStageChanges: ([_, head, _workdir, stage]: [string, number, number, number]): boolean =>
            stage !== head,

        hasWorkdirChanges: ([_, head, workdir]: [string, number, number, number]): boolean =>
            workdir !== head,

        isAnyChange: ([_, head, workdir, stage]: [string, number, number, number]): boolean =>
            this.fileStatus.isNew([_, head, workdir, stage]) ||
            this.fileStatus.isModified([_, head, workdir, stage]) ||
            this.fileStatus.isDeleted([_, head, workdir, stage]) ||
            this.fileStatus.hasStageChanges([_, head, workdir, stage]) ||
            this.fileStatus.hasWorkdirChanges([_, head, workdir, stage]),
    };

    /**
     * Check if the working copy has any changes
     */
    private async getWorkingCopyState(dir: string): Promise<{ isDirty: boolean; status: any[] }> {
        const status = await git.statusMatrix({ fs, dir });
        console.log(
            "Status before committing local changes:",
            JSON.stringify(
                status.filter(
                    (entry) => entry.includes(0) || entry.includes(2) || entry.includes(3)
                )
            )
        );
        return { isDirty: status.some((entry) => this.fileStatus.isAnyChange(entry)), status };
    }

    /**
     * Complete a merge after conflicts have been resolved
     */
    async completeMerge(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string },
        resolvedFiles: Array<{
            filepath: string;
            resolution: "deleted" | "created" | "modified";
        }>
    ): Promise<void> {
        // Check if sync is already in progress
        if (this.stateManager.isSyncLocked()) {
            console.log("Sync already in progress, cannot complete merge");
            throw new Error("Sync operation already in progress. Please try again later.");
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock(dir);
        if (!lockAcquired) {
            console.log("Failed to acquire sync lock, cannot complete merge");
            throw new Error("Failed to acquire sync lock. Please try again later.");
        }

        try {
            this.debugLog(
                "=== Starting completeMerge because client called and passed resolved files ==="
            );
            this.debugLog(`Resolved files: ${resolvedFiles.map((f) => f.filepath).join(", ")}`);

            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // Stage the resolved files based on their resolution type
            for (const { filepath, resolution } of resolvedFiles) {
                this.debugLog(
                    `Processing resolved file: ${filepath} with resolution: ${resolution}`
                );

                if (resolution === "deleted") {
                    console.log(`Removing file from git: ${filepath}`);
                    await git.remove({ fs, dir, filepath });
                } else {
                    console.log(`Adding file to git: ${filepath}`);
                    await git.add({ fs, dir, filepath });
                }
            }

            // Get the current state before creating the merge commit
            const localHead = await git.resolveRef({ fs, dir, ref: currentBranch });
            const remoteRef = this.getRemoteRef(currentBranch);
            const remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });

            // Fetch latest changes to ensure we have the most recent remote state
            console.log("[GitService] Fetching latest changes before merge completion");
            await this.withTimeout(
                git.fetch({
                    fs,
                    http,
                    dir,
                    onAuth: () => {
                        console.log("[GitService] Authentication requested for pre-merge fetch");
                        return auth;
                    },
                }),
                2 * 60 * 1000,
                "Pre-merge fetch operation"
            );
            const commitMessage = `Merge branch 'origin/${currentBranch}'`;
            console.log(`Creating merge commit with message: ${commitMessage}`);

            try {
                // Create a merge commit with the two parents
                await git.commit({
                    fs,
                    dir,
                    message: commitMessage,
                    author: {
                        name: author.name,
                        email: author.email,
                        timestamp: Math.floor(Date.now() / 1000),
                        timezoneOffset: new Date().getTimezoneOffset(),
                    },
                    parent: [localHead, remoteHead],
                });
            } catch (commitError) {
                console.error("Error creating merge commit:", commitError);

                // Create a regular commit instead
                console.log("Attempting to create a regular commit with the resolved changes");
                await git.commit({
                    fs,
                    dir,
                    message: `Resolved conflicts with ${this.getShortRemoteRef(currentBranch)}`,
                    author: {
                        name: author.name,
                        email: author.email,
                        timestamp: Math.floor(Date.now() / 1000),
                        timezoneOffset: new Date().getTimezoneOffset(),
                    },
                });
            }

            // Push the merge commit with a more robust approach
            console.log("Pushing merge commit");
            try {
                // Try normal push first
                await this.safePush(dir, auth, { ref: currentBranch });
                console.log("Successfully pushed merge commit");
            } catch (pushError) {
                console.error("Error pushing merge commit:", pushError);
                throw new Error(
                    `Failed to push merge commit: ${pushError instanceof Error ? pushError.message : String(pushError)}`
                );
            }

            console.log("=== completeMerge completed successfully ===");
        } catch (error) {
            console.error("Complete merge error:", error);
            throw new Error(
                `Complete merge operation failed: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            // Always release the lock when done, regardless of success or failure
            await this.stateManager.releaseSyncLock();
        }
    }

    /**
     * Stage all changes in the working directory
     */
    async addAll(dir: string): Promise<void> {
        const status = await git.statusMatrix({ fs, dir });

        // Handle deletions
        const deletedFiles = status
            .filter((entry) => this.fileStatus.isDeleted(entry))
            .map(([filepath]) => filepath);

        for (const filepath of deletedFiles) {
            await git.remove({ fs, dir, filepath });
        }

        // Handle modifications and additions
        const modifiedFiles = status
            .filter(
                (entry) =>
                    this.fileStatus.isNew(entry) ||
                    (this.fileStatus.hasWorkdirChanges(entry) && !this.fileStatus.isDeleted(entry))
            )
            .map(([filepath]) => filepath);

        for (const filepath of modifiedFiles) {
            await git.add({ fs, dir, filepath });
        }
    }

    /**
     * Stage all changes, routing LFS-tracked files through LFS upload.
     * This preserves the working tree's original binary content after staging.
     */
    async addAllWithLFS(dir: string, auth: { username: string; password: string }): Promise<void> {
        const status = await git.statusMatrix({ fs, dir });

        // Handle deletions
        const deletedFiles = status
            .filter((entry) => this.fileStatus.isDeleted(entry))
            .map(([filepath]) => filepath);

        for (const filepath of deletedFiles) {
            await git.remove({ fs, dir, filepath });
        }

        // Handle modifications and additions
        const modifiedFiles = status
            .filter(
                (entry) =>
                    this.fileStatus.isNew(entry) ||
                    (this.fileStatus.hasWorkdirChanges(entry) && !this.fileStatus.isDeleted(entry))
            )
            .map(([filepath]) => filepath);

        for (const filepath of modifiedFiles) {
            await this.addWithLFS(dir, filepath, auth);
        }
    }

    /**
     * Create a commit with the given message
     */
    async commit(
        dir: string,
        message: string,
        author: { name: string; email: string }
    ): Promise<string> {
        return git.commit({
            fs,
            dir,
            message,
            author: {
                name: author.name,
                email: author.email,
                timestamp: Math.floor(Date.now() / 1000),
                timezoneOffset: new Date().getTimezoneOffset(),
            },
        });
    }

    // ========== UTILITY METHODS ==========

    async clone(
        url: string,
        dir: string,
        auth?: { username: string; password: string }
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Cloning repository...",
                cancellable: false,
            },
            async (progress) => {
                try {
                    // Ensure the directory exists
                    const dirUri = vscode.Uri.file(dir);
                    await vscode.workspace.fs.createDirectory(dirUri);

                    await git.clone({
                        fs,
                        http,
                        dir,
                        url,
                        onProgress: (event) => {
                            if (event.phase === "Receiving objects") {
                                progress.report({
                                    message: `${event.phase}: ${event.loaded}/${event.total} objects`,
                                    increment: (event.loaded / event.total) * 100,
                                });
                            }
                        },
                        ...(auth && {
                            onAuth: () => auth,
                        }),
                    });
                } catch (error) {
                    console.error("Clone error:", error);
                    throw new Error(
                        `Failed to clone repository: ${error instanceof Error ? error.message : "Unknown error"}`
                    );
                }
            }
        );
    }

    async add(dir: string, filepath: string): Promise<void> {
        await git.add({ fs, dir, filepath });
    }

    async remove(dir: string, filepath: string): Promise<void> {
        await git.remove({ fs, dir, filepath });
    }

    async getStatus(dir: string): Promise<Array<[string, number, number, number]>> {
        return git.statusMatrix({ fs, dir });
    }

    async getCurrentBranch(dir: string): Promise<string | undefined> {
        return (await git.currentBranch({ fs, dir })) || undefined;
    }

    async listBranches(dir: string): Promise<string[]> {
        return git.listBranches({ fs, dir });
    }

    async checkout(dir: string, ref: string): Promise<void> {
        await git.checkout({ fs, dir, ref });
    }

    async init(dir: string): Promise<void> {
        try {
            await git.init({ fs, dir, defaultBranch: "main" });
            await git.branch({ fs, dir, ref: "main", checkout: true });
        } catch (error) {
            console.error("Init error:", error);
            throw new Error(
                `Failed to initialize repository: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    async getRemoteUrl(dir: string): Promise<string | undefined> {
        try {
            const remotes = await git.listRemotes({ fs, dir });
            const origin = remotes.find((remote) => remote.remote === "origin");
            return origin?.url;
        } catch (error) {
            console.error("Error getting remote URL:", error);
            return undefined;
        }
    }

    async getRemotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
        return git.listRemotes({ fs, dir });
    }

    async addRemote(dir: string, name: string, url: string): Promise<void> {
        try {
            await git.addRemote({ fs, dir, remote: name, url });
        } catch (error) {
            // If remote already exists, update it
            if (error instanceof Error && error.message.includes("already exists")) {
                await git.deleteRemote({ fs, dir, remote: name });
                await git.addRemote({ fs, dir, remote: name, url });
            } else {
                throw error;
            }
        }
    }

    async removeRemote(dir: string, name: string): Promise<void> {
        try {
            await git.deleteRemote({ fs, dir, remote: name });
        } catch (error) {
            console.error(`Error removing remote ${name}:`, error);
            // If the remote doesn't exist, that's fine
            if (!(error instanceof Error && error.message.includes("remote does not exist"))) {
                throw error;
            }
        }
    }

    async hasGitRepository(dir: string): Promise<boolean> {
        try {
            await git.resolveRef({ fs, dir, ref: "HEAD" });
            return true;
        } catch (error) {
            return false;
        }
    }

    async configureAuthor(dir: string, name: string, email: string): Promise<void> {
        await this.setConfig(dir, "user.name", name);
        await this.setConfig(dir, "user.email", email);
    }

    async setConfig(dir: string, path: string, value: string): Promise<void> {
        await git.setConfig({ fs, dir, path, value });
    }

    async getConfig(dir: string, path: string): Promise<string | void> {
        return git.getConfig({ fs, dir, path });
    }

    async push(
        dir: string,
        auth: { username: string; password: string },
        options?: { force?: boolean }
    ): Promise<void> {
        await this.safePush(dir, auth, { force: options?.force });
    }

    async isOnline(): Promise<boolean> {
        try {
            // Check internet connectivity by making HEAD requests and checking response codes
            const userIsOnline = await fetch("https://gitlab.com", {
                method: "HEAD",
                cache: "no-store", // Prevent caching
            })
                .then((res) => (res as Response).status === 200)
                .catch(() => false);

            const apiIsOnline = await fetch("https://api.frontierrnd.com")
                .then((res) => {
                    console.log("apiIsOnline", { res });
                    return (res as Response).status === 200;
                })
                .catch(() => false);

            if (!userIsOnline) {
                vscode.window.showWarningMessage(
                    "You are offline. Please connect to the internet to sync changes."
                );
            }
            if (!apiIsOnline) {
                vscode.window.showWarningMessage(
                    "The API is offline. Please try again later. Your local changes are saved, and will sync to the cloud when the API is back online."
                );
            }
            return userIsOnline && apiIsOnline;
        } catch (error) {
            return false;
        }
    }

    /**
     * Helper method to get the short reference to a remote branch
     * @param branch The branch name
     * @returns The short reference to the remote branch
     */
    private getShortRemoteRef(branch: string): string {
        return `origin/${branch}`;
    }

    /**
     * Helper method to get the full reference to a remote branch
     * @param branch The branch name
     * @returns The full reference to the remote branch
     */
    private getRemoteRef(branch: string): string {
        return `refs/remotes/origin/${branch}`;
    }

    /**
     * Helper method to resolve a reference to a commit hash
     * @param dir The repository directory
     * @param ref The reference to resolve
     * @returns The commit hash
     */
    private async resolveReference(dir: string, ref: string): Promise<string> {
        return git.resolveRef({ fs, dir, ref });
    }

    /**
     * Helper method to resolve a remote branch reference to a commit hash
     * @param dir The repository directory
     * @param branch The branch name
     * @returns The commit hash of the remote branch
     */
    private async resolveRemoteReference(dir: string, branch: string): Promise<string> {
        return this.resolveReference(dir, this.getRemoteRef(branch));
    }

    async fastForward(
        dir: string,
        currentBranch: string,
        auth: { username: string; password: string }
    ): Promise<boolean> {
        try {
            // Fetch the latest changes from the remote
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });

            // Get the current commit
            const currentCommit = await git.resolveRef({
                fs,
                dir,
                ref: currentBranch,
            });

            // Get the remote commit
            const remoteRef = this.getRemoteRef(currentBranch);
            const remoteCommit = await git.resolveRef({
                fs,
                dir,
                ref: remoteRef,
            });

            // Fast-forward just updates local HEAD to match remote, no pushing needed
            await git.fastForward({
                fs,
                http,
                dir,
                ref: currentBranch,
                onAuth: () => auth,
            });

            return true;
        } catch (error) {
            console.log("Fast-forward failed, identifying conflicts");
            return false;
        }
    }

    async getRemoteBranchStatus(
        dir: string,
        currentBranch: string,
        auth: { username: string; password: string }
    ): Promise<RemoteBranchStatus> {
        try {
            // Fetch the latest changes from the remote
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });

            // Check if the remote branch exists
            try {
                await git.resolveRef({
                    fs,
                    dir,
                    ref: this.getRemoteRef(currentBranch),
                });
            } catch (error) {
                // Remote branch doesn't exist
                return RemoteBranchStatus.NOT_FOUND;
            }

            return RemoteBranchStatus.FOUND;
        } catch (error) {
            console.error("Error getting remote branch status:", error);
            return RemoteBranchStatus.ERROR;
        }
    }

    async mergeRemote(
        dir: string,
        currentBranch: string,
        auth: { username: string; password: string }
    ): Promise<boolean> {
        try {
            // Merge the remote branch into the current branch
            await git.merge({
                fs,
                dir,
                ours: currentBranch,
                theirs: this.getRemoteRef(currentBranch),
                author: {
                    name: "Genesis",
                    email: "genesis@example.com",
                },
                message: `Merge branch '${this.getShortRemoteRef(currentBranch)}' into ${currentBranch}`,
            });
            return true;
        } catch (error) {
            console.error("Error merging remote branch:", error);
            return false;
        }
    }

    async checkoutRemote(dir: string, currentBranch: string): Promise<void> {
        await git.checkout({
            fs,
            dir,
            ref: this.getShortRemoteRef(currentBranch),
        });
    }

    // Add this helper method to the GitService class
    private areStatusEntriesEqual(
        entry1?: [string, number, number, number],
        entry2?: [string, number, number, number]
    ): boolean {
        if (!entry1 || !entry2) {
            return false;
        }
        // Compare HEAD status (index 1)
        return entry1[1] === entry2[1];
    }

    // =========================
    // LFS INTEGRATION HELPERS
    // =========================

    /**
     * Parse .gitattributes and return globs that have filter=lfs
     */
    private async getLfsGlobs(dir: string): Promise<string[]> {
        try {
            const attrsPath = path.join(dir, ".gitattributes");
            const text = await fs.promises.readFile(attrsPath, "utf8");
            const globs: string[] = [];

            for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line || line.startsWith("#")) continue;

                // naive split: "<pattern> attr[=val] attr[=val] ..."
                const [pattern, ...attrs] = line.split(/\s+/);
                if (!pattern) continue;

                // explicitly contain "filter=lfs"
                const hasLfs = attrs.some((a) => /^filter\s*=\s*lfs$/i.test(a));
                if (hasLfs) globs.push(pattern);
            }
            return globs;
        } catch {
            // No .gitattributes is fine
            return [];
        }
    }

    /**
     * Very small glob -> RegExp converter supporting "*", "?", and "**"
     */
    private globToRegExp(glob: string): RegExp {
        // Escape regex specials
        let s = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        // ** -> match multi-segment
        s = s.replace(/\\\*\\\*/g, ".*");
        // * -> match any except path separator
        s = s.replace(/\\\*/g, "[^/]*");
        // ? -> match single char except path separator
        s = s.replace(/\\\?/g, "[^/]");
        return new RegExp("^" + s + "$");
    }

    private async isLfsTracked(dir: string, filepath: string): Promise<boolean> {
        const globs = await this.getLfsGlobs(dir);
        if (globs.length === 0) return false;

        // Normalize to forward slashes relative to repo root
        const rel = filepath.replace(/\\/g, "/");
        for (const g of globs) {
            const re = this.globToRegExp(g);
            if (re.test(rel)) return true;
        }
        return false;
    }

    private sha256(buf: Buffer | Uint8Array): string {
        return crypto.createHash("sha256").update(buf).digest("hex");
    }

    /** Get LFS batch endpoint from a standard remote URL */
    private lfsBatchUrl(remoteUrl: string): string {
        // Ensure trailing ".git" removed just once
        const base = remoteUrl.replace(/\.git$/i, "");
        return `${base}/info/lfs/objects/batch`;
    }

    /**
     * Basic auth header for GitLab using username + PAT (password)
     */
    private basicAuthHeader(auth: { username: string; password: string }): string {
        const token = Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64");
        return `Basic ${token}`;
    }

    /**
     * Upload a single blob to LFS (idempotent).
     * Returns { oid, size } – enough to build a pointer file.
     */
    private async lfsUploadOne(opts: {
        remoteUrl: string;
        auth: { username: string; password: string };
        data: Uint8Array;
    }): Promise<{ oid: string; size: number }> {
        const { remoteUrl, auth, data } = opts;
        const oid = this.sha256(data);
        const size = data.byteLength;

        const batchUrl = this.lfsBatchUrl(remoteUrl);
        const headers = {
            "Content-Type": "application/vnd.git-lfs+json",
            Accept: "application/vnd.git-lfs+json",
            Authorization: this.basicAuthHeader(auth),
        };

        // 1) Ask server about upload
        const batchBody = JSON.stringify({
            operation: "upload",
            transfers: ["basic"],
            objects: [{ oid, size }],
        });

        const batchRes = await fetch(batchUrl, { method: "POST", headers, body: batchBody });
        if (!(batchRes as Response).ok) {
            const t = await (batchRes as Response).text().catch(() => "");
            throw new Error(
                `LFS batch upload negotiation failed: ${(batchRes as Response).status} ${t}`
            );
        }

        const batchJson: any = await (batchRes as Response).json();

        if (!Array.isArray(batchJson.objects) || !batchJson.objects[0]) {
            // If object array missing, assume already present
            return { oid, size };
        }

        const obj = batchJson.objects[0];
        const actions = obj.actions || {};

        // 2) If upload required, PUT the bytes to actions.upload.href
        if (actions.upload?.href) {
            const method = actions.upload.header?.["x-http-method"] ?? "PUT";
            const putRes = await fetch(actions.upload.href, {
                method,
                headers: {
                    ...(actions.upload.header || {}),
                    // GitLab often signs the URL; Authorization usually not required, but harmless if present.
                    Authorization: this.basicAuthHeader(auth),
                    "Content-Type": "application/octet-stream",
                    "Content-Length": String(size),
                },
                body: data as any,
            });
            if (!(putRes as Response).ok) {
                const t = await (putRes as Response).text().catch(() => "");
                throw new Error(`LFS upload failed: ${(putRes as Response).status} ${t}`);
            }
        }

        // 3) If verify step provided, POST it
        if (actions.verify?.href) {
            const verifyRes = await fetch(actions.verify.href, {
                method: "POST",
                headers: {
                    ...(actions.verify.header || {}),
                    Authorization: this.basicAuthHeader(auth),
                    "Content-Type": "application/vnd.git-lfs+json",
                },
                body: JSON.stringify({ oid, size }),
            });
            if (!(verifyRes as Response).ok) {
                const t = await (verifyRes as Response).text().catch(() => "");
                throw new Error(`LFS verify failed: ${(verifyRes as Response).status} ${t}`);
            }
        }

        return { oid, size };
    }

    /** Build Git LFS pointer file text */
    private buildLfsPointer(oidHex: string, size: number): string {
        return [
            "version https://git-lfs.github.com/spec/v1",
            `oid sha256:${oidHex}`,
            `size ${size}`,
            "",
        ].join("\n");
    }

    /**
     * For a given path: if tracked by LFS, upload to LFS, stage pointer,
     * then restore the original content in the working tree so the user can keep working.
     */
    private async addWithLFS(
        dir: string,
        filepath: string,
        auth: { username: string; password: string }
    ): Promise<void> {
        // If not LFS-tracked, do normal add
        if (!(await this.isLfsTracked(dir, filepath))) {
            await git.add({ fs, dir, filepath });
            return;
        }

        // Read original bytes
        const abs = path.join(dir, filepath);
        const buf = await fs.promises.readFile(abs);

        // Resolve remote URL
        const remoteUrl = await this.getRemoteUrl(dir);
        if (!remoteUrl) {
            // Fall back: just add as normal if we have no remote yet
            console.warn(`[GitService] No remote URL; adding ${filepath} without LFS`);
            await git.add({ fs, dir, filepath });
            return;
        }

        // Upload to LFS (idempotent; server will skip if already present)
        const { oid, size } = await this.lfsUploadOne({
            remoteUrl,
            auth,
            data: buf,
        });

        // Build pointer file content
        const pointer = this.buildLfsPointer(oid, size);

        // Write pointer, stage it, then restore original bytes locally
        await fs.promises.writeFile(abs, pointer);
        await git.add({ fs, dir, filepath });
        await fs.promises.writeFile(abs, buf);
    }
}
