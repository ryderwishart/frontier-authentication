import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";

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
}

export enum RemoteBranchStatus {
    FOUND,
    NOT_FOUND,
    ERROR,
}

export class GitService {
    private stateManager: StateManager;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
    }

    // Below is a simplified version. It commits if dirty, fetches remote changes, tries pulling (which will error on merge conflicts), and then either pushes or returns a list of files that differ.
    async syncChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string }
    ): Promise<SyncResult> {
        // Check if sync is already in progress
        if (this.stateManager.isSyncLocked()) {
            console.log("Sync already in progress, skipping this request");
            return { hadConflicts: false };
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock();
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
                console.log("Working copy is dirty, committing local changes");
                await this.addAll(dir);
                await this.commit(dir, "Local changes", author);
            }

            // 2. Check if we're online
            if (!(await this.isOnline())) {
                throw new Error("Offline");
            }

            // 3. Fetch remote changes to get latest state
            console.log("Fetching remote changes");
            await git.fetch({ fs, http, dir, onAuth: () => auth });

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
                await git.push({ fs, http, dir, remote: "origin", onAuth: () => auth });
                return { hadConflicts: false };
            }

            const mergeBaseCommits = await git.findMergeBase({
                fs,
                dir,
                oids: [localHead, remoteHead],
            });

            console.log("Merge base commits:", mergeBaseCommits);

            // Get files changed in local HEAD
            const localStatusMatrix = await git.statusMatrix({ fs, dir });
            // Get files changed in remote HEAD
            const remoteStatusMatrix = await git.statusMatrix({
                fs,
                dir,
                ref: remoteRef,
            });
            const mergeBaseStatusMatrix =
                mergeBaseCommits.length > 0
                    ? await git.statusMatrix({
                          fs,
                          dir,
                          ref: mergeBaseCommits[0],
                      })
                    : [];

            console.log(
                "workingCopyStatusBeforeCommit:",
                JSON.stringify(workingCopyStatusBeforeCommit)
            );
            console.log("localStatusMatrix:", JSON.stringify(localStatusMatrix));
            console.log("mergeBaseStatusMatrix:", JSON.stringify(mergeBaseStatusMatrix));
            console.log("remoteStatusMatrix:", JSON.stringify(remoteStatusMatrix));

            // 6. If local and remote are identical, nothing to do
            if (localHead === remoteHead) {
                console.log("Local and remote are already in sync");
                return { hadConflicts: false };
            }

            // 7. Try fast-forward first (simplest case)
            try {
                console.log("Attempting fast-forward");
                await git.fastForward({
                    fs,
                    http,
                    dir,
                    ref: currentBranch,
                    onAuth: () => auth,
                });

                // Fast-forward worked, push any local changes
                console.log("Fast-forward successful, pushing any local changes");
                await git.push({
                    fs,
                    http,
                    dir,
                    remote: "origin",
                    onAuth: () => auth,
                });

                return { hadConflicts: false };
            } catch (err) {
                console.log("Fast-forward failed, need to handle conflicts");
            }

            // 8. If we get here, we have divergent histories - check for conflicts
            console.log("Fast-forward failed, need to handle conflicts");

            // Convert status matrices to maps for easier lookup
            const localStatusMap = new Map(
                localStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const remoteStatusMap = new Map(
                remoteStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const mergeBaseStatusMap = new Map(
                mergeBaseStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
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
                    remoteStatus[0] === 1 &&
                    (!localStatus || localStatus[0] === 0) &&
                    (!mergeBaseStatus || mergeBaseStatus[0] === 0)
                ) {
                    filesAddedOnRemote.push(filepath);
                    continue;
                }

                // File exists in local but not in remote or merge base -> added locally
                if (
                    localStatus &&
                    localStatus[0] === 1 &&
                    (!remoteStatus || remoteStatus[0] === 0) &&
                    (!mergeBaseStatus || mergeBaseStatus[0] === 0)
                ) {
                    filesAddedLocally.push(filepath);
                    continue;
                }

                // File exists in merge base and local but not in remote -> deleted on remote
                if (
                    mergeBaseStatus &&
                    mergeBaseStatus[0] === 1 &&
                    localStatus &&
                    localStatus[0] === 1 &&
                    (!remoteStatus || remoteStatus[0] === 0)
                ) {
                    filesDeletedOnRemote.push(filepath);
                    continue;
                }

                // File exists in merge base and remote but not in local -> deleted locally
                if (
                    mergeBaseStatus &&
                    mergeBaseStatus[0] === 1 &&
                    remoteStatus &&
                    remoteStatus[0] === 1 &&
                    (!localStatus || localStatus[0] === 0)
                ) {
                    filesDeletedLocally.push(filepath);
                    continue;
                }

                // File exists in all three but has different content
                if (
                    localStatus &&
                    localStatus[0] === 1 &&
                    remoteStatus &&
                    remoteStatus[0] === 1 &&
                    mergeBaseStatus &&
                    mergeBaseStatus[0] === 1
                ) {
                    const localModified = localStatus[1] === 2; // workdir different from HEAD
                    const remoteModified = remoteStatus[1] === 2; // workdir different from HEAD
                    const mergeBaseModified = mergeBaseStatus[1] === 2; // merge base different from HEAD

                    // Treat all modified files as potential conflicts for simplicity
                    if (localModified || remoteModified || mergeBaseModified) {
                        filesModifiedAndTreatedAsPotentialConflict.push(filepath);
                    }
                }
            }

            // Additional validation to ensure files are properly categorized
            // Filter out files from filesDeletedLocally that are actually added on remote
            // const updatedFilesDeletedLocally = filesDeletedLocally.filter(
            //     (filepath) => !filesAddedOnRemote.includes(filepath)
            // );

            // // Reassign the array contents while preserving the original reference
            // filesDeletedLocally.length = 0;
            // filesDeletedLocally.push(...updatedFilesDeletedLocally);

            console.log("Files added locally:", filesAddedLocally);
            console.log("Files deleted locally:", filesDeletedLocally);
            console.log("Files added on remote:", filesAddedOnRemote);
            console.log("Files deleted on remote:", filesDeletedOnRemote);
            console.log(
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

            console.log("All changed files:", allChangedFilePaths);

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
                    // A file is truly deleted if:
                    // 1. It's deleted locally and not modified remotely (user wants to delete)
                    // 2. It's deleted remotely and not modified locally (remote deleted it)
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
                                console.log(`Error reading locally added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        console.log(`File ${filepath} doesn't exist in local HEAD`);
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
                            // For remotely added files, we need to read from remote HEAD
                            try {
                                const { blob: rBlob } = await git.readBlob({
                                    fs,
                                    dir,
                                    oid: remoteHead,
                                    filepath,
                                });
                                remoteContent = new TextDecoder().decode(rBlob);
                            } catch (e) {
                                console.log(`Error reading remotely added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        console.log(`File ${filepath} doesn't exist in remote HEAD`);
                    }

                    // Try to read base content if available
                    try {
                        if (mergeBaseCommits.length > 0) {
                            const { blob: bBlob } = await git.readBlob({
                                fs,
                                dir,
                                oid: mergeBaseCommits[0],
                                filepath,
                            });
                            baseContent = new TextDecoder().decode(bBlob);
                        }
                    } catch (err) {
                        console.log(`File ${filepath} doesn't exist in merge base`);
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
            console.error("Sync error:", err);
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
        const lockAcquired = await this.stateManager.acquireSyncLock();
        if (!lockAcquired) {
            console.log("Failed to acquire sync lock, cannot complete merge");
            throw new Error("Failed to acquire sync lock. Please try again later.");
        }

        try {
            console.log(
                "=== Starting completeMerge because client called and passed resolved files ==="
            );
            console.log(`Resolved files: ${resolvedFiles.map((f) => f.filepath).join(", ")}`);

            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // Stage the resolved files based on their resolution type
            for (const { filepath, resolution } of resolvedFiles) {
                console.log(`Processing resolved file: ${filepath} with resolution: ${resolution}`);

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
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });
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
                await git.push({
                    fs,
                    http,
                    dir,
                    remote: "origin",
                    ref: currentBranch,
                    onAuth: () => auth,
                });
                console.log("Successfully pushed merge commit");
            } catch (pushError) {
                console.error("Error pushing merge commit:", pushError);
            }

            console.log("=== completeMerge completed successfully ===");
        } catch (error) {
            console.error("Complete merge error:", error);
            throw error;
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
        await git.push({
            fs,
            http,
            dir,
            remote: "origin",
            onAuth: () => auth,
            ...(options && { force: options.force }),
        });
    }

    async isOnline(): Promise<boolean> {
        try {
            // Check internet connectivity by making HEAD requests and checking response codes
            const userIsOnline = await fetch("https://gitlab.com", {
                method: "HEAD",
                cache: "no-store", // Prevent caching
            })
                .then((res) => res.status === 200)
                .catch(() => false);

            const apiIsOnline = await fetch("https://api.frontierrnd.com")
                .then((res) => {
                    console.log("RYDER: apiIsOnline", { res });
                    return res.status === 200;
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
}
