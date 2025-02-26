import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";
import * as diff3 from "diff3";

export interface ConflictedFile {
    filepath: string;
    ours: string;
    theirs: string;
    base: string;
}

export interface SyncResult {
    hadConflicts: boolean;
    conflicts?: ConflictedFile[];
}

export class GitService {
    constructor() {
        // No initialization needed
    }

    /**
     * Main sync method following the flowchart logic:
     * 1. Check if working copy is dirty
     * 2. If yes, stage and commit changes
     * 3. Fetch & pull remote changes
     * 4. Check for conflicts
     * 5. If conflicts exist, return them for resolution
     * 6. If no conflicts, push changes
     */
    async syncChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string }
    ): Promise<SyncResult> {
        try {
            console.log("=== Starting syncChanges ===");
            //! Housekeeping checks
            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            //! We want to make sure we don't lose any local changes that aren't staged yet
            // 1. Check if working copy is dirty
            const isDirty = await this.isWorkingCopyDirty(dir);
            console.log(`Working copy is ${isDirty ? "dirty" : "clean"}`);

            // 2. If working copy is dirty, stage and commit changes
            if (isDirty) {
                console.log("Staging and committing local changes");
                await this.addAll(dir);
                await this.commit(dir, "Local changes", author);
            }

            //! At this point, if there is no network connection, just throw a vscode warning message saying that we can't sync changes while offline
            if (!(await this.isOnline())) {
                return { hadConflicts: false };
            }

            //! We want to make sure we don't lose any remote changes
            // 3. Fetch remote changes
            console.log("Fetching remote changes");
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });

            // 4. Check for conflicts between local and remote HEAD
            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            const localHead = await git.resolveRef({ fs, dir, ref: currentBranch });
            const remoteRef = `refs/remotes/origin/${currentBranch}`;
            let remoteHead;

            try {
                remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });
            } catch (error) {
                // If remote branch doesn't exist yet, just push our changes
                console.log("Remote branch doesn't exist, pushing our changes");
                await this.push(dir, auth);
                return { hadConflicts: false };
            }

            // If local and remote are the same, just return success
            if (localHead === remoteHead) {
                console.log("Local and remote are in sync");
                return { hadConflicts: false };
            }

            // // Check if remote changes can be fast-forwarded
            // const canFastForward = await git.isDescendent({
            //     fs,
            //     dir,
            //     oid: remoteHead,
            //     ancestor: localHead,
            // }); // FIXME: sometimes it says we can fast forward, but we have commits with content that conflict with the remote, and so we should not fast forward, but rather find the conflicts

            // if (canFastForward) {
            //     // Simple case: just update our ref to match remote
            //     console.log("Fast-forwarding local to match remote");

            //     // First checkout so we're not on the ref we're trying to update
            //     await git.checkout({ fs, dir, ref: currentBranch, force: true });

            //     // Then update the ref safely
            //     await git.writeRef({
            //         fs,
            //         dir,
            //         ref: `refs/heads/${currentBranch}`,
            //         value: remoteHead,
            //         force: true,
            //     });

            //     // And checkout again to update working directory
            //     await git.checkout({ fs, dir, ref: currentBranch });
            //     return { hadConflicts: false };
            // }

            // // Check if our changes can be fast-forwarded
            // const remoteCanFastForward = await git.isDescendent({
            //     fs,
            //     dir,
            //     oid: localHead,
            //     ancestor: remoteHead,
            // });

            // if (remoteCanFastForward) {
            //     // Simple case: just push our changes
            //     console.log("Local is ahead, pushing changes");
            //     await this.push(dir, auth);
            //     return { hadConflicts: false };
            // }

            // We have divergent histories - need to check for conflicts
            console.log("Divergent histories, checking for conflicts");
            const conflicts = await this.findConflicts(dir, localHead, remoteHead);

            if (conflicts.length > 0) {
                console.log(`Found ${conflicts.length} conflicts that need resolution`);
                return {
                    hadConflicts: true,
                    conflicts: conflicts,
                };
            }

            // Divergent but no conflicts - create a merge commit
            console.log("No conflicts found, creating merge commit");

            // First make sure we have the correct index state
            await git.checkout({ fs, dir, ref: currentBranch, force: true });

            // Now create a merge commit with both parents
            try {
                const mergeCommitSha = await git.commit({
                    fs,
                    dir,
                    message: `Merge remote-tracking branch 'origin/${currentBranch}' into ${currentBranch}`,
                    author: {
                        name: author.name,
                        email: author.email,
                        timestamp: Math.floor(Date.now() / 1000),
                        timezoneOffset: new Date().getTimezoneOffset(),
                    },
                    parent: [localHead, remoteHead],
                });
                console.log(`Created merge commit: ${mergeCommitSha}`);
            } catch (error) {
                // If commit fails, we might need to do a manual merge
                console.log("Commit failed, attempting manual merge:", error);

                // Run a reset to make sure we're in a clean state
                await git.checkout({ fs, dir, ref: currentBranch, force: true });

                // Perform a merge operation
                const baseOid = await git.findMergeBase({
                    fs,
                    dir,
                    oids: [localHead, remoteHead],
                });

                if (!baseOid || baseOid.length === 0) {
                    throw new Error("Cannot find a merge base between local and remote");
                }

                await git.merge({
                    fs,
                    dir,
                    ours: localHead,
                    theirs: remoteHead,
                    fastForwardOnly: false,
                    author: {
                        name: author.name,
                        email: author.email,
                    },
                });
            }

            // 5. Push changes
            console.log("Pushing changes to remote");
            try {
                await this.push(dir, auth);
            } catch (pushError) {
                // If push fails with non-fast-forward error, try to force push
                if (
                    pushError instanceof Error &&
                    (pushError.message.includes("non-fast-forward") ||
                        pushError.message.includes("failed to push"))
                ) {
                    console.log("Push failed, attempting force push");
                    await this.push(dir, auth);
                } else {
                    throw pushError;
                }
            }

            console.log("=== syncChanges completed successfully ===");
            return { hadConflicts: false };
        } catch (error) {
            console.error("Error syncing changes:", error);
            throw error;
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
    private async isWorkingCopyDirty(dir: string): Promise<boolean> {
        const status = await git.statusMatrix({ fs, dir });
        console.log("Status:", JSON.stringify(status));
        return status.some((entry) => this.fileStatus.isAnyChange(entry));
    }

    /**
     * Find conflicts between local and remote branches
     */
    private async findConflicts(
        dir: string,
        localHead: string,
        remoteHead: string
    ): Promise<ConflictedFile[]> {
        console.log("=== Starting simplified findConflicts ===");
        try {
            // Get all files from local HEAD
            const localFiles = await git.listFiles({ fs, dir, ref: localHead });
            console.log(`Found ${localFiles.length} files in local HEAD`);

            // Get all files from remote HEAD
            const remoteFiles = await git.listFiles({ fs, dir, ref: remoteHead });
            console.log(`Found ${remoteFiles.length} files in remote HEAD`);

            // Combine all unique filepaths
            const allFilepaths = new Set([...localFiles, ...remoteFiles]);
            console.log(`Total unique files to check: ${allFilepaths.size}`);

            // Track identical and different files
            const identicalFiles: string[] = [];
            const differentFiles: string[] = [];
            const conflicts: ConflictedFile[] = [];

            // Compare each file
            for (const filepath of allFilepaths) {
                // Get local version
                let localContent: string;
                try {
                    const { blob } = await git.readBlob({
                        fs,
                        dir,
                        oid: localHead,
                        filepath,
                    });
                    localContent = new TextDecoder().decode(blob);
                } catch (error) {
                    console.log(`File ${filepath} doesn't exist in local HEAD`);
                    localContent = ""; // File doesn't exist in local
                }

                // Get remote version
                let remoteContent: string;
                try {
                    const { blob } = await git.readBlob({
                        fs,
                        dir,
                        oid: remoteHead,
                        filepath,
                    });
                    remoteContent = new TextDecoder().decode(blob);
                } catch (error) {
                    console.log(`File ${filepath} doesn't exist in remote HEAD`);
                    remoteContent = ""; // File doesn't exist in remote
                }

                // Get base version (common ancestor)
                let baseContent = "";
                try {
                    const mergeBase = await git.findMergeBase({
                        fs,
                        dir,
                        oids: [localHead, remoteHead],
                    });

                    if (mergeBase && mergeBase.length > 0) {
                        try {
                            const { blob } = await git.readBlob({
                                fs,
                                dir,
                                oid: mergeBase[0],
                                filepath,
                            });
                            baseContent = new TextDecoder().decode(blob);
                        } catch (error) {
                            // File doesn't exist in base
                        }
                    }
                } catch (error) {
                    // Couldn't find merge base
                }

                // Compare the contents
                if (localContent === remoteContent) {
                    identicalFiles.push(filepath);
                } else {
                    differentFiles.push(filepath);

                    // Add to conflicts list
                    conflicts.push({
                        filepath,
                        ours: localContent,
                        theirs: remoteContent,
                        base: baseContent,
                    });
                }
            }

            // Log results
            console.log("=== File comparison results ===");
            console.log(`Identical files (${identicalFiles.length}): ${identicalFiles.join(", ")}`);
            console.log(`Different files (${differentFiles.length}): ${differentFiles.join(", ")}`);

            return conflicts;
        } catch (error) {
            console.error("Error comparing files:", error);
            return [];
        }
    }

    /**
     * Complete a merge after conflicts have been resolved
     */
    async completeMerge(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string },
        resolvedFiles: string[]
    ): Promise<void> {
        try {
            console.log("=== Starting completeMerge ===");
            console.log(`Resolved files: ${resolvedFiles.join(", ")}`);

            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // Stage the resolved files
            for (const filepath of resolvedFiles) {
                console.log(`Staging resolved file: ${filepath}`);
                await git.add({ fs, dir, filepath });
            }

            // Create a merge commit
            const localHead = await git.resolveRef({ fs, dir, ref: currentBranch });
            const remoteHead = await git.resolveRef({
                fs,
                dir,
                ref: `refs/remotes/origin/${currentBranch}`,
            });

            const commitMessage = `Merge branch 'origin/${currentBranch}'`;
            console.log(`Creating merge commit with message: ${commitMessage}`);

            try {
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

                // Try a different approach - force checkout and then commit
                await git.checkout({ fs, dir, ref: currentBranch, force: true });

                // Re-stage the resolved files
                for (const filepath of resolvedFiles) {
                    await git.add({ fs, dir, filepath });
                }

                // Create a regular commit instead of a merge commit
                await git.commit({
                    fs,
                    dir,
                    message: `Resolved conflicts with origin/${currentBranch}`,
                    author: {
                        name: author.name,
                        email: author.email,
                        timestamp: Math.floor(Date.now() / 1000),
                        timezoneOffset: new Date().getTimezoneOffset(),
                    },
                });
            }

            // Push the merge commit
            console.log("Pushing merge commit");
            try {
                await this.push(dir, auth); // note: I don't know if this is ever going to work the first time without force
            } catch (pushError) {
                // If push fails due to non-fast-forward, try force push
                if (
                    pushError instanceof Error &&
                    (pushError.message.includes("non-fast-forward") ||
                        pushError.message.includes("failed to push"))
                ) {
                    console.log("Push failed, attempting force push");
                    await this.push(dir, auth, { force: true });
                } else {
                    throw pushError;
                }
            }

            console.log("=== completeMerge completed successfully ===");
        } catch (error) {
            console.error("Complete merge error:", error);
            throw error;
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

    /**
     * Push changes to remote with retry logic
     */
    async push(
        dir: string,
        auth: { username: string; password: string },
        pushOptions?: { force?: boolean }
    ): Promise<void> {
        // try {
        //     // First attempt to push
        //     await git.push({ // NOTE: I feel like this will always fail
        //         fs,
        //         http,
        //         dir,
        //         remote: "origin",
        //         onAuth: () => auth,
        //         ...(pushOptions && { force: pushOptions.force }),
        //     });
        // } catch (error) {
        //     console.log("Initial push failed, trying to fetch latest changes and retry");

        // If push fails, fetch latest changes
        await git.fetch({
            fs,
            http,
            dir,
            onAuth: () => auth,
        });

        // Pull the latest changes
        const currentBranch = await git.currentBranch({ fs, dir });
        if (!currentBranch) {
            throw new Error("Not on any branch");
        }

        await git.pull({
            fs,
            http,
            dir,
            ref: currentBranch,
            onAuth: () => auth,
            author: {
                name: "Automatic Merger",
                email: "auto@example.com",
            },
        });

        // Try pushing again
        await git.push({
            fs,
            http,
            dir,
            remote: "origin",
            onAuth: () => auth,
            ...(pushOptions && { force: pushOptions.force }),
        });
        // }
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
}
