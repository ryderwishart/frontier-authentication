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

            //! Housekeeping checks
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

            //! Housekeeping checks
            //! At this point, if there is no network connection, just throw a vscode warning message saying that we can't sync changes while offline
            if (!(await this.isOnline())) {
                return { hadConflicts: false };
            }

            // Fetch the latest changes from remote before comparing HEADs
            console.log("Fetching latest changes from remote before comparing HEADs");
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });

            // Get the local and remote HEADs (i.e., the commit hashes)
            const localHead = await git.resolveRef({ fs, dir, ref: currentBranch });
            const remoteRef = `origin/${currentBranch}`;
            let remoteHead;

            //! Housekeeping checks
            //! make sure remote branch exists
            try {
                remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });
            } catch (error) {
                // If remote branch doesn't exist yet, just push our changes
                console.log("Remote branch doesn't exist, syncing our changes");
                await this.sync(dir, auth);
                return { hadConflicts: false };
            }

            console.log("REFS after fetch:", { localHead, remoteHead, remoteRef });

            //! Housekeeping checks
            //! If local and remote are the same, just return success
            if (localHead === remoteHead) {
                console.log("Local and remote are in sync");
                return { hadConflicts: false };
            } // note: we now know we have divergent histories, so we need to check for conflicts

            //! We want to make sure we don't lose any remote changes
            // 3. Fetch remote changes
            console.log("Fetching remote changes");
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });

            console.log("Attempting fast-forward");
            try {
                await git.fastForward({
                    fs,
                    http,
                    dir,
                    ref: currentBranch,
                    onAuth: () => auth,
                });
                return { hadConflicts: false };
            } catch (error) {
                console.log("Fast-forward failed, identifying conflicts");
            }

            const localStatusMatrixAfterCommitting = await git.statusMatrix({ fs, dir });
            const remoteStatusMatrixOfRemoteHEAD = await git.statusMatrix({
                fs,
                dir,
                ref: remoteRef,
            });

            //! if we get here, we have a divergent history, so we need to check for files that may conflict
            const filePathsChangedOnRemote = remoteStatusMatrixOfRemoteHEAD
                .filter((entry) => entry.includes(0) || entry.includes(2) || entry.includes(3))
                .map((entry) => entry[0]);
            const filePathsChangedOnLocal = localStatusMatrixAfterCommitting
                .filter((entry) => entry.includes(0) || entry.includes(2) || entry.includes(3))
                .map((entry) => entry[0]);
            console.log("RYDER:", { filePathsChangedOnRemote, filePathsChangedOnLocal });

            //! We have divergent histories - need to check for conflicts
            console.log("Divergent histories, checking for conflicts");
            const filePathsThatHaveChangedOnBothRefs = filePathsChangedOnLocal.filter(
                (filePath) => filePathsChangedOnRemote.includes(filePath) // if the file is changed on both, it may conflict
            );
            console.log("RYDER:", { filePathsThatHaveChangedOnBothRefs });

            const allFilesThatHaveChanged =
                filePathsChangedOnLocal.concat(filePathsChangedOnRemote);
            // we need to get all the remote files that have changed too, or they will get left behind

            // For each potential conflict, load the content and check if there's an actual conflict
            const conflicts: ConflictedFile[] = [];
            if (filePathsThatHaveChangedOnBothRefs.length > 0) {
                for (const filePath of allFilesThatHaveChanged) {
                    console.log("RYDER:", { filePath });
                    // // Get base version
                    // let baseContent = "";
                    // try {
                    //     const { blob } = await git.readBlob({
                    //         fs,
                    //         dir,
                    //         oid: mergeBase,
                    //         filepath: filePath,
                    //     });
                    //     baseContent = new TextDecoder().decode(blob);
                    // } catch (error) {
                    //     // File might not exist in base
                    // }

                    // Get local version
                    let localContent: string;
                    try {
                        const { blob } = await git.readBlob({
                            fs,
                            dir,
                            oid: localHead,
                            filepath: filePath,
                        });
                        localContent = new TextDecoder().decode(blob); // TODO: determine if we can just compare the blobs instead of decoding
                    } catch (error) {
                        console.log(`File ${filePath} doesn't exist in local HEAD`);
                        localContent = ""; // File doesn't exist in local
                    }

                    // Get remote version
                    let remoteContent: string;
                    try {
                        const { blob } = await git.readBlob({
                            fs,
                            dir,
                            oid: remoteHead,
                            filepath: filePath,
                        });
                        remoteContent = new TextDecoder().decode(blob);
                    } catch (error) {
                        console.log(`File ${filePath} doesn't exist in remote HEAD`);
                        remoteContent = ""; // File doesn't exist in remote
                    }

                    console.log("RYDER:", {
                        localContent: localContent.slice(0, 500),
                        remoteContent: remoteContent.slice(0, 500),
                    });

                    // If content is different, we have a conflict
                    if (localContent !== remoteContent) {
                        conflicts.push({
                            filepath: filePath,
                            ours: localContent,
                            theirs: remoteContent,
                            base: "",
                        });
                    }
                }

                console.log(
                    `Found ${filePathsThatHaveChangedOnBothRefs.length} potential conflicts that need resolution`
                );

                return {
                    hadConflicts: true,
                    conflicts,
                };
            }

            // if we get here, there are no potential conflicts, so we can just pull and push (sync)

            // 5. Sync changes
            console.log("Syncing changes to remote");
            try {
                // if we get here, we have tried pull --ff and it failed
                // we have also checked to see if there are any conflicts
                // but we know now there are no conflicts, so we can just pull and push
                // so we can just call sync, but ...
                // WHY do we end up here? Isn't this what fast-forward is for?
                // await this.sync(dir, auth);
                // if fast forward can't work here, then we need to make a merge commit
                // by calling this.completeMerge, and only adding files changed on local or remote but not both (since none have changed on both)

                // we are here because in the past we were force pushing
                await this.mergeAllChanges(
                    dir,
                    auth,
                    author,
                    filePathsChangedOnLocal,
                    filePathsChangedOnRemote,
                    localHead,
                    remoteHead
                );
            } catch (pushError) {
                // If push fails with non-fast-forward error, try to force push
                if (
                    pushError instanceof Error &&
                    (pushError.message.includes("non-fast-forward") ||
                        pushError.message.includes("failed to push"))
                ) {
                    console.log("Push failed, attempting force push");
                    await this.sync(dir, auth, { force: true });
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
        console.log(
            "Status before committing local changes:",
            JSON.stringify(
                status.filter(
                    (entry) => entry.includes(0) || entry.includes(2) || entry.includes(3)
                )
            )
        );
        return status.some((entry) => this.fileStatus.isAnyChange(entry));
    }

    // /**
    //  * Find conflicts between local and remote branches using Git's merge-base
    //  * and diff algorithms to efficiently identify potential conflicts
    //  */
    // private async findConflicts(
    //     dir: string,
    //     localHead: string,
    //     remoteHead: string
    // ): Promise<{ conflicts: ConflictedFile[]; changesOnRemote: string[] }> {
    //     console.log("=== Starting optimized findConflicts ===");

    //     try {
    //         // Find the common ancestor (merge base) of the two branches
    //         const mergeBaseResult = await git.findMergeBase({
    //             fs,
    //             dir,
    //             oids: [localHead, remoteHead],
    //         });

    //         if (!mergeBaseResult || mergeBaseResult.length === 0) {
    //             console.log("No common ancestor found between branches");
    //             // If no common ancestor, we need to compare all files
    //             return {
    //                 conflicts: await this.findConflictsByFullComparison(dir, localHead, remoteHead),
    //                 changesOnRemote: [],
    //             };
    //         }

    //         const mergeBase = mergeBaseResult[0];
    //         console.log(`Found merge base: ${mergeBase}`);

    //         // Get files changed between merge-base and local
    //         const localChanges = await this.getChangedFiles(dir, mergeBase, localHead);
    //         console.log(`Files changed in local: ${JSON.stringify(localChanges)}`);

    //         // Get files changed between merge-base and remote
    //         const remoteChanges = await this.getChangedFiles(dir, mergeBase, remoteHead);
    //         console.log(`Files changed in remote: ${JSON.stringify(remoteChanges)}`);

    //         // Find files changed in both branches (potential conflicts)
    //         const potentialConflicts = localChanges.filter((local) =>
    //             remoteChanges.some((remote) => remote.path === local.path)
    //         );

    //         console.log(`Potential conflict files: ${JSON.stringify(potentialConflicts)}`);

    //         // // For each potential conflict, load the content and check if there's an actual conflict
    //         // const conflicts: ConflictedFile[] = [];

    //         // for (const file of potentialConflicts) {
    //         //     const filepath = file.path;
    //         //     console.log("RYDER:", { filepath });
    //         //     // Get base version
    //         //     let baseContent = "";
    //         //     try {
    //         //         const { blob } = await git.readBlob({
    //         //             fs,
    //         //             dir,
    //         //             oid: mergeBase,
    //         //             filepath,
    //         //         });
    //         //         baseContent = new TextDecoder().decode(blob);
    //         //     } catch (error) {
    //         //         // File might not exist in base
    //         //     }

    //         //     // Get local version
    //         //     let localContent: string;
    //         //     try {
    //         //         const { blob } = await git.readBlob({
    //         //             fs,
    //         //             dir,
    //         //             oid: localHead,
    //         //             filepath,
    //         //         });
    //         //         localContent = new TextDecoder().decode(blob);
    //         //     } catch (error) {
    //         //         console.log(`File ${filepath} doesn't exist in local HEAD`);
    //         //         localContent = ""; // File doesn't exist in local
    //         //     }

    //         //     // Get remote version
    //         //     let remoteContent: string;
    //         //     try {
    //         //         const { blob } = await git.readBlob({
    //         //             fs,
    //         //             dir,
    //         //             oid: remoteHead,
    //         //             filepath,
    //         //         });
    //         //         remoteContent = new TextDecoder().decode(blob);
    //         //     } catch (error) {
    //         //         console.log(`File ${filepath} doesn't exist in remote HEAD`);
    //         //         remoteContent = ""; // File doesn't exist in remote
    //         //     }

    //         //     console.log("RYDER:", {
    //         //         localContent: localContent.slice(0, 500),
    //         //         remoteContent: remoteContent.slice(0, 500),
    //         //     });

    //         //     // If content is different, we have a conflict
    //         //     if (localContent !== remoteContent) {
    //         //         conflicts.push({
    //         //             filepath,
    //         //             ours: localContent,
    //         //             theirs: remoteContent,
    //         //             base: baseContent,
    //         //         });
    //         //     }
    //         // }

    //         console.log(`Actual conflicts found: ${conflicts.length}`);
    //         return { conflicts, remoteChanges };
    //     } catch (error) {
    //         console.error("Error finding conflicts:", error);
    //         // Fall back to full comparison if the optimized approach fails
    //         return {
    //             conflicts: await this.findConflictsByFullComparison(dir, localHead, remoteHead),
    //             changesOnRemote: [],
    //         };
    //     }
    // }

    // /**
    //  * Get files that changed between two commits
    //  */
    // private async getChangedFiles(
    //     dir: string,
    //     fromOid: string, // merge base head
    //     toOid: string // local or remote head
    // ): Promise<Array<{ path: string; type: string }>> {
    //     try {
    //         const statusMatrix = await git.statusMatrix({
    //             fs,
    //             dir,
    //             ref: toOid,
    //         });

    //         return statusMatrix
    //             .filter((entry) => this.fileStatus.isAnyChange(entry))
    //             .map(([filepath, head, workdir, stage]) => {
    //                 let type = "modified";
    //                 if (this.fileStatus.isNew([filepath, head, workdir, stage])) {
    //                     type = "added";
    //                 } else if (this.fileStatus.isDeleted([filepath, head, workdir, stage])) {
    //                     type = "deleted";
    //                 }
    //                 return { path: filepath, type };
    //             });
    //     } catch (error) {
    //         console.error(`Error getting changed files between ${fromOid} and ${toOid}:`, error);
    //         return [];
    //     }
    // }

    // /**
    //  * Fall back method that compares all files (current implementation)
    //  */
    // private async findConflictsByFullComparison(
    //     dir: string,
    //     localHead: string,
    //     remoteHead: string
    // ): Promise<ConflictedFile[]> {
    //     console.log("=== Falling back to full file comparison ===");

    //     try {
    //         // Get all files from local HEAD
    //         const localFiles = await git.listFiles({ fs, dir, ref: localHead });
    //         console.log(`Found ${localFiles.length} files in local HEAD`);

    //         // Get all files from remote HEAD
    //         const remoteFiles = await git.listFiles({ fs, dir, ref: remoteHead });
    //         console.log(`Found ${remoteFiles.length} files in remote HEAD`);

    //         // Combine all unique filepaths
    //         const allFilepaths = new Set([...localFiles, ...remoteFiles]);
    //         console.log(`Total unique files to check: ${allFilepaths.size}`);

    //         // Track conflicts
    //         const conflicts: ConflictedFile[] = [];

    //         // Compare each file
    //         for (const filepath of allFilepaths) {
    //             // Get local version
    //             let localContent: string;
    //             try {
    //                 const { blob } = await git.readBlob({
    //                     fs,
    //                     dir,
    //                     oid: localHead,
    //                     filepath,
    //                 });
    //                 localContent = new TextDecoder().decode(blob);
    //             } catch (error) {
    //                 console.log(`File ${filepath} doesn't exist in local HEAD`);
    //                 localContent = ""; // File doesn't exist in local
    //             }

    //             // Get remote version
    //             let remoteContent: string;
    //             try {
    //                 const { blob } = await git.readBlob({
    //                     fs,
    //                     dir,
    //                     oid: remoteHead,
    //                     filepath,
    //                 });
    //                 remoteContent = new TextDecoder().decode(blob);
    //             } catch (error) {
    //                 console.log(`File ${filepath} doesn't exist in remote HEAD`);
    //                 remoteContent = ""; // File doesn't exist in remote
    //             }

    //             // Get base version (common ancestor)
    //             let baseContent = "";
    //             try {
    //                 const mergeBase = await git.findMergeBase({
    //                     fs,
    //                     dir,
    //                     oids: [localHead, remoteHead],
    //                 });

    //                 if (mergeBase && mergeBase.length > 0) {
    //                     try {
    //                         const { blob } = await git.readBlob({
    //                             fs,
    //                             dir,
    //                             oid: mergeBase[0],
    //                             filepath,
    //                         });
    //                         baseContent = new TextDecoder().decode(blob);
    //                     } catch (error) {
    //                         // File doesn't exist in base
    //                     }
    //                 }
    //             } catch (error) {
    //                 // Couldn't find merge base
    //             }

    //             // Compare the contents
    //             if (localContent !== remoteContent) {
    //                 // Add to conflicts list
    //                 conflicts.push({
    //                     filepath,
    //                     ours: localContent,
    //                     theirs: remoteContent,
    //                 });
    //             }
    //         }

    //         return conflicts;
    //     } catch (error) {
    //         console.error("Error comparing files:", error);
    //         return [];
    //     }
    // }

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
            console.log(
                "=== Starting completeMerge because client called and passed resolved files ==="
            );
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
                        name: author.name,
                        email: author.email,
                    },
                });

                // note: We have to force push here because isomorphic-git doesn't support merges with conflicts
                // but we are already handling the conflicts in the client, and so the working copy is ready to push
                await this.sync(dir, auth, { force: true });
            } catch (pushError) {
                // If push fails due to non-fast-forward, try force push
                console.error("Force push failed in completeMerge:", pushError);
                throw pushError;
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
     * Sync changes with remote
     */
    async sync(
        dir: string,
        auth: { username: string; password: string },
        pushOptions?: { force?: boolean }
    ): Promise<void> {
        console.log("=== Starting sync ===", { dir, pushOptions });

        // Fetch the latest changes
        console.log("Fetching latest changes from remote");
        await git.fetch({
            fs,
            http,
            dir,
            onAuth: () => auth,
        });

        // Get current branch
        console.log("Getting current branch");
        const currentBranch = await git.currentBranch({ fs, dir });
        console.log("Current branch:", currentBranch);
        if (!currentBranch) {
            throw new Error("Not on any branch");
        }

        try {
            // If working copy is clean and histories have diverged,
            // we can safely reset to remote state instead of trying to merge
            console.log("Checking if working copy is clean");
            const isDirty = await this.isWorkingCopyDirty(dir); // this is redundant here, but it's a sanity check so we don't force checkout remote and lose something
            console.log("Working copy dirty status:", isDirty);

            if (!isDirty) {
                // NOTE: once we get here, we CAN fast forward, because we know the remote branch exists, there are changes on it, and no changes or potential conflicts on the local
                console.log("Working copy is clean, attempting fast-forward/reset to remote state");
                // Try pulling (this might fail with merge conflicts)
                console.log("Attempting to pull changes");
                await git.fastForward({
                    fs,
                    http,
                    dir,
                    ref: currentBranch,
                    onAuth: () => auth,
                });

                console.log("Successfully reset to remote state, no push needed");
                // No need to push since we just adopted remote changes
                return;
            }
        } catch (pullError) {
            console.log("Pull failed:", pullError);
            // If pull fails with merge not supported, and working copy is clean,
            // we can reset to remote state
            // FIXME: can we remove this?
            if (
                pullError instanceof Error &&
                pullError.message.includes("Merges with conflicts are not supported")
            ) {
                console.log("Merge conflicts detected, checking if we can safely reset");
                const isDirty = await this.isWorkingCopyDirty(dir);
                console.log("Working copy dirty status:", isDirty);

                if (!isDirty) {
                    console.log("Working copy clean, resetting to remote state");
                    // Reset to remote state
                    await git.fetch({
                        fs,
                        http,
                        dir,
                        ref: currentBranch,
                        remote: "origin",
                        onAuth: () => auth,
                    });

                    await git.checkout({
                        fs,
                        dir,
                        ref: currentBranch,
                        force: true,
                        remote: "origin",
                    });

                    console.log("Successfully reset to remote state, no push needed");
                    // No need to push since we just adopted remote changes
                    return;
                } else {
                    console.log("Working copy is dirty, cannot auto-resolve conflicts");
                    // If working copy is dirty, we can't automatically resolve
                    throw pullError;
                }
            } else {
                console.log("Pull failed with unexpected error");
                throw pullError;
            }
        }

        // Try pushing
        console.log("Attempting to push changes", { pushOptions });
        await git.push({
            fs,
            http,
            dir,
            remote: "origin",
            onAuth: () => auth,
            ...(pushOptions && { force: pushOptions.force }),
        });
        console.log("Push successful");
        console.log("=== Sync completed successfully ===");
    }

    async mergeAllChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string },
        filePathsChangedOnLocal: string[],
        filePathsChangedOnRemote: string[],
        localHead: string,
        remoteHead: string
    ): Promise<void> {
        // get all the files that changed on the remote
        // add them to the working copy
        // commit them
        // push them as a merge commit with the local and remote refs as parents
        // if it fails, one last force push?
        // if it still fails, throw an error
        console.log("=== Starting mergeAllChanges ===");
        console.log("Files changed on local:", filePathsChangedOnLocal);
        console.log("Files changed on remote:", filePathsChangedOnRemote);

        try {
            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            console.log("Local HEAD:", localHead);
            console.log("Remote HEAD:", remoteHead);

            // 1. First, save any local changes to a temporary area
            const localChanges = new Map<string, Uint8Array>();
            for (const filepath of filePathsChangedOnLocal) {
                try {
                    const { blob } = await git.readBlob({
                        fs,
                        dir,
                        oid: localHead,
                        filepath,
                    });
                    localChanges.set(filepath, blob);
                } catch (error) {
                    console.log(`File ${filepath} doesn't exist in local HEAD, might be deleted`);
                    // Mark as deleted
                    localChanges.set(filepath, new Uint8Array());
                }
            }

            console.log("Local changes:", { localChanges });

            // 2. Checkout the remote branch to get all remote changes
            console.log("Checking out remote branch to get remote changes");
            await git.checkout({
                // force here because we already saved the local changes in memory (need to dump these somewhere in a temp file?)
                fs,
                dir,
                ref: currentBranch,
                force: true,
                remote: "origin",
            });

            console.log("Local changes after checkout:", { localChanges });
            console.log("all the stuff we might woender about the git status, refs, HEAD, etc.", {
                status,
                refs: await git.listRemotes({ fs, dir }),
                currentBranch,
                localHead,
                remoteHead,
            });

            // 3. Apply local changes on top of remote changes
            console.log("Applying local changes on top of remote changes");
            for (const [filepath, content] of localChanges.entries()) {
                if (content.length === 0) {
                    // This file was deleted in local
                    console.log(`Removing file that was deleted locally: ${filepath}`);
                    try {
                        await git.remove({ fs, dir, filepath });
                    } catch (error) {
                        console.log(`Error removing file ${filepath}:`, error);
                        // File might not exist on remote either, that's fine
                    }
                } else {
                    console.log(`Writing local version of file: ${filepath}`);
                    // Write the file to the working directory
                    const filePath = path.join(dir, filepath);
                    const dirPath = path.dirname(filePath);

                    // Ensure directory exists
                    await fs.promises.mkdir(dirPath, { recursive: true });

                    // Write file
                    await fs.promises.writeFile(filePath, content);

                    // Stage the file
                    await git.add({ fs, dir, filepath });
                }
            }

            // 4. Create a merge commit
            console.log("Creating merge commit");
            await git.commit({
                fs,
                dir,
                message: `Merge branch 'origin/${currentBranch}' into ${currentBranch}`,
                author: {
                    name: author.name,
                    email: author.email,
                    timestamp: Math.floor(Date.now() / 1000),
                    timezoneOffset: new Date().getTimezoneOffset(),
                },
                parent: [localHead, remoteHead], // This makes it a merge commit
            });

            // 5. Push the merge commit - modified approach
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

                // If push fails, try force push as a last resort - if this is continually happening, cry, then rethink your logic in syncChanges

                // Before force pushing, check if remote has changed since we last fetched
                console.log("Checking if remote has changed before force pushing");
                await git.fetch({
                    fs,
                    http,
                    dir,
                    onAuth: () => auth,
                });

                const currentRemoteHead = await git.resolveRef({
                    fs,
                    dir,
                    ref: `origin/${currentBranch}`,
                });

                if (currentRemoteHead !== remoteHead) {
                    console.log("Remote has changed since we started merging!");
                    throw new Error(
                        "Cannot push changes because the remote branch has been updated. " +
                            "Please sync again to incorporate the latest changes."
                    );
                }

                // If remote hasn't changed, force push is safer
                if (
                    pushError instanceof Error &&
                    (pushError.message.includes("non-fast-forward") ||
                        pushError.message.includes("failed to push"))
                ) {
                    console.log("Push failed, attempting force push");
                    await git.push({
                        fs,
                        http,
                        dir,
                        remote: "origin",
                        ref: currentBranch,
                        force: true,
                        onAuth: () => auth,
                    });
                    console.log("Force push successful");
                } else {
                    throw pushError;
                }
            }

            console.log("=== mergeAllChanges completed successfully ===");
        } catch (error) {
            console.error("Error in mergeAllChanges:", error);
            throw error;
        }
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
}
