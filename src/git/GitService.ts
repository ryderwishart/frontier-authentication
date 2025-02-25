import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";
import * as diff3 from "diff3";
import { PushResult } from "isomorphic-git";

interface PullResult {
    hadConflicts: boolean;
    needsMerge?: boolean;
    localOid?: string;
    remoteOid?: string;
    conflicts?: ConflictedFile[];
}

export class GitService {
    constructor() {
        // No need to initialize filesystem anymore as we're using the real fs
    }

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
                    // Ensure the directory exists using VS Code's file system API
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

    async addAll(dir: string): Promise<void> {
        const status = await git.statusMatrix({ fs, dir });
        console.log(
            "Status in addAll:",
            status.map((s) => `${s[0]}: head=${s[1]}, workdir=${s[2]}, stage=${s[3]}`)
        );

        // First, handle deletions
        const deletedFiles = status
            .filter(([_, head, workdir]) => head === 1 && workdir === 0)
            .map(([filepath]) => filepath);

        console.log("Staging deletions:", deletedFiles);

        for (const filepath of deletedFiles) {
            await git.remove({ fs, dir, filepath });
        }

        // Then handle actual modifications and new files
        const modifiedFiles = status
            .filter(([_, head, workdir, stage]) => {
                // Only stage if:
                // - untracked (head === 0 && workdir === 1)
                // - modified (head === 1 && workdir === 1 && head !== workdir)
                return (
                    (head === 0 && workdir === 1) || // New file
                    (head === 1 && workdir === 1 && stage !== workdir) // This checks if working dir differs from staged
                ); // Modified file
            })
            .map(([filepath]) => filepath);

        console.log("Staging modifications:", modifiedFiles);

        for (const filepath of modifiedFiles) {
            await git.add({ fs, dir, filepath });
        }
    }

    async commit(
        dir: string,
        message: string,
        author: { name: string; email: string }
    ): Promise<string> {
        const sha = await git.commit({
            fs,
            dir,
            message,
            author,
        });
        return sha;
    }

    async push(
        dir: string,
        auth: { username: string; password: string },
        force: boolean = false
    ): Promise<PushResult> {
        try {
            // Configure author before pushing
            await this.configureAuthor(dir, "oauth2", auth.password);

            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            return git.push({
                fs,
                http,
                dir,
                remote: "origin",
                ref: currentBranch,
                force,
                onAuth: () => ({
                    username: auth.username,
                    password: auth.password,
                }),
            });
        } catch (error) {
            console.error("Push error:", error);
            throw error;
        }
    }

    async pull(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string }
    ): Promise<PullResult> {
        try {
            // First fetch the changes
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });

            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // Get remote ref and OIDs
            const remoteRef = `refs/remotes/origin/${currentBranch}`;
            const remoteOid = await git.resolveRef({ fs, dir, ref: remoteRef });
            const localOid = await git.resolveRef({ fs, dir, ref: currentBranch });

            // Can we fast-forward?
            const canFastForward = await git.isDescendent({
                fs,
                dir,
                oid: remoteOid,
                ancestor: localOid,
            });

            // If we can fast-forward, do it
            if (canFastForward) {
                await git.writeRef({
                    fs,
                    dir,
                    ref: `refs/heads/${currentBranch}`,
                    value: remoteOid,
                    force: true,
                });
                await git.checkout({ fs, dir, ref: currentBranch });
                return { hadConflicts: false };
            }

            // Get modified files that would conflict
            const status = await git.statusMatrix({ fs, dir });
            const modifiedFiles = this.getModifiedFiles(status);

            // If we have potentially conflicting files, get their versions
            if (modifiedFiles.length > 0) {
                const conflicts = await Promise.all(
                    modifiedFiles.map(async (filepath) => {
                        try {
                            // Get all versions of the file
                            const ours = await this.readFileContent(dir, filepath).catch(() => "");
                            const theirs = await this.readRemoteContent(
                                dir,
                                filepath,
                                remoteOid
                            ).catch(() => "");
                            const base = await this.getBaseVersion(
                                dir,
                                filepath,
                                localOid,
                                remoteOid
                            ).catch(() => "");

                            // Only consider it a conflict if the content actually differs
                            // and at least one version exists
                            if ((ours || theirs) && ours !== theirs) {
                                return {
                                    filepath,
                                    ours,
                                    theirs,
                                    base,
                                };
                            }
                            return null;
                        } catch (error) {
                            console.error(`Error processing file ${filepath}:`, error);
                            return null;
                        }
                    })
                );

                // Filter out null entries and files that aren't actually conflicts
                const validConflicts = conflicts.filter(
                    (conflict): conflict is ConflictedFile => conflict !== null
                );

                return {
                    hadConflicts: true,
                    needsMerge: true,
                    localOid,
                    remoteOid,
                    conflicts: validConflicts,
                };
            }

            return {
                hadConflicts: false,
                needsMerge: true,
                localOid,
                remoteOid,
            };
        } catch (error) {
            console.error("Pull operation error:", error);
            throw error;
        }
    }

    async getStatus(dir: string): Promise<Array<[string, number, number, number]>> {
        const status = await git.statusMatrix({ fs, dir });
        console.log("RYDER: Raw git status:", status);
        return status;
    }

    async getConflictedFiles(dir: string): Promise<string[]> {
        const status = await this.getStatus(dir);
        return status
            .filter(([, , , workdirStatus]) => workdirStatus === 2) // 2 indicates conflict
            .map(([filepath]) => filepath);
    }

    async getCurrentBranch(dir: string): Promise<string | void> {
        return git.currentBranch({ fs, dir }) || "main";
    }

    async listBranches(dir: string): Promise<string[]> {
        return git.listBranches({ fs, dir });
    }

    async checkout(dir: string, ref: string): Promise<void> {
        await git.checkout({ fs, dir, ref });
    }

    async log(dir: string, depth: number = 10): Promise<Array<{ oid: string; commit: any }>> {
        return git.log({ fs, dir, depth });
    }

    async getRemoteUrl(dir: string): Promise<string | undefined> {
        try {
            const config = await git.listRemotes({
                fs,
                dir,
            });

            const origin = config.find((remote) => remote.remote === "origin");
            return origin?.url;
        } catch (error) {
            console.error("Error getting remote URL:", error);
            return undefined;
        }
    }

    async init(dir: string): Promise<void> {
        try {
            // Initialize with explicit main branch
            await git.init({ fs, dir, defaultBranch: "main" });

            // Explicitly create and checkout main branch
            await git.branch({ fs, dir, ref: "main", checkout: true });

            console.log("Git repository initialized at:", dir);
        } catch (error) {
            console.error("Init error:", error);
            throw new Error(
                `Failed to initialize repository: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    async addRemote(dir: string, name: string, url: string): Promise<void> {
        try {
            await git.addRemote({ fs, dir, remote: name, url });
            console.log("Added remote:", name, url);
        } catch (error) {
            // If remote already exists, try to update it
            if (error instanceof Error && error.message.includes("already exists")) {
                await git.deleteRemote({ fs, dir, remote: name });
                await git.addRemote({ fs, dir, remote: name, url });
                console.log("Updated existing remote:", name, url);
            } else {
                console.error("Add remote error:", error);
                throw new Error(
                    `Failed to add remote: ${error instanceof Error ? error.message : "Unknown error"}`
                );
            }
        }
    }

    async getRemotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
        try {
            return await git.listRemotes({ fs, dir });
        } catch (error) {
            console.error("List remotes error:", error);
            throw new Error(
                `Failed to list remotes: ${error instanceof Error ? error.message : "Unknown error"}`
            );
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

    async setConfig(dir: string, path: string, value: string): Promise<void> {
        try {
            await git.setConfig({
                fs,
                dir,
                path,
                value,
            });
            // console.log(`Git config set: ${path} = ${value}`);
        } catch (error) {
            console.error("Set config error:", error);
            throw new Error(
                `Failed to set git config: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    async getConfig(dir: string, path: string): Promise<string | void> {
        try {
            const value = await git.getConfig({
                fs,
                dir,
                path,
            });
            return value;
        } catch (error) {
            console.error("Get config error:", error);
            return undefined;
        }
    }

    async configureAuthor(dir: string, name: string, email: string): Promise<void> {
        await this.setConfig(dir, "user.name", name);
        await this.setConfig(dir, "user.email", email);
    }

    async getConflictVersions(
        dir: string,
        filepath: string
    ): Promise<{
        ours: string;
        theirs: string;
        base: string;
    }> {
        try {
            // Get the current working copy (ours)
            const workingCopyUri = vscode.Uri.file(path.join(dir, filepath));
            const oursContent = await vscode.workspace.fs.readFile(workingCopyUri);

            // Get the remote content (theirs)
            let theirsContent = new Uint8Array();
            try {
                // Get the current branch name
                const currentBranch = await git.currentBranch({ fs, dir });

                // Get the remote ref (e.g., 'refs/remotes/origin/main')
                const remoteRef = `refs/remotes/origin/${currentBranch}`;

                // Get the remote commit
                const remoteOid = await git.resolveRef({ fs, dir, ref: remoteRef });

                if (remoteOid) {
                    try {
                        // Read the file from the remote commit
                        const { blob } = await git.readBlob({
                            fs,
                            dir,
                            oid: remoteOid,
                            filepath,
                        });
                        theirsContent = blob;
                    } catch (err) {
                        console.error(`Error reading remote file content: ${err}`);
                    }
                }
            } catch (err) {
                console.error("Error getting remote content:", err);
            }

            return {
                base: "", // We don't need the base version for our conflict resolution
                ours: new TextDecoder().decode(oursContent),
                theirs: new TextDecoder().decode(theirsContent),
            };
        } catch (error) {
            console.error(`Error getting conflict versions for ${filepath}:`, error);
            return {
                base: "",
                ours: "",
                theirs: "",
            };
        }
    }

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
            console.log(`Current branch: ${currentBranch}`);

            // Configure author before committing
            await this.configureAuthor(dir, author.name, author.email);

            // Stage only the resolved files, not everything
            for (const file of resolvedFiles) {
                console.log(`Staging resolved file: ${file}`);
                await git.add({ fs, dir, filepath: file });
            }

            // Create merge commit with both parents
            const localOid = await git.resolveRef({ fs, dir, ref: currentBranch });
            const remoteOid = await git.resolveRef({
                fs,
                dir,
                ref: `refs/remotes/origin/${currentBranch}`,
            });
            console.log(`Local OID: ${localOid}, Remote OID: ${remoteOid}`);

            const commitMessage = `Merge branch 'origin/${currentBranch}'\n\nResolved conflicts:\n${resolvedFiles.join("\n")}`;
            console.log(`Creating merge commit with message: ${commitMessage}`);

            const commitSha = await git.commit({
                fs,
                dir,
                message: commitMessage,
                author: {
                    name: author.name,
                    email: author.email,
                    timestamp: Math.floor(Date.now() / 1000),
                    timezoneOffset: new Date().getTimezoneOffset(),
                },
                parent: [localOid, remoteOid],
            });
            console.log(`Created merge commit: ${commitSha}`);

            // Try to push, if it fails with non-fast-forward, try force push
            try {
                console.log("Pushing merge commit to remote");
                await this.push(dir, auth);
                console.log("Push completed successfully");
            } catch (error) {
                if (error instanceof Error && error.message?.includes("failed to update ref")) {
                    console.log("Push failed, attempting force push");
                    // Try force push as a fallback
                    await this.push(dir, auth, true);
                    console.log("Force push completed");
                } else {
                    console.error("Push failed with error:", error);
                    throw error;
                }
            }
            console.log("=== completeMerge completed successfully ===");
        } catch (error) {
            console.error("Complete merge error:", error);
            throw error;
        }
    }

    async syncChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string }
    ): Promise<PullResult> {
        try {
            console.log("=== Starting syncChanges ===");

            // 1. Get the current status of the repository
            const status = await git.statusMatrix({ fs, dir });

            // Log the status for debugging
            console.log(
                "Git status before sync:",
                status.map((s) => `${s[0]}: head=${s[1]}, workdir=${s[2]}, stage=${s[3]}`)
            );

            // Only stage files that are actually modified by the user
            // This is more selective than the previous approach
            const actuallyModifiedFiles = status
                .filter(([_, head, workdir, stage]) => {
                    // Only consider files that have been modified in the working directory
                    // compared to HEAD, or are new files
                    return (
                        (head === 0 && workdir === 1) || // New file
                        (head === 1 && workdir === 1 && stage !== workdir)
                    ); // Modified file
                })
                .map(([filepath]) => filepath);

            console.log("Actually modified files:", actuallyModifiedFiles);

            // Only stage the files that are actually modified
            for (const filepath of actuallyModifiedFiles) {
                console.log(`Staging modified file: ${filepath}`);
                await git.add({ fs, dir, filepath });
            }

            // Handle deletions separately and explicitly
            const deletedFiles = status
                .filter(([_, head, workdir]) => head === 1 && workdir === 0)
                .map(([filepath]) => filepath);

            console.log("Deleted files:", deletedFiles);

            for (const filepath of deletedFiles) {
                console.log(`Staging deletion: ${filepath}`);
                await git.remove({ fs, dir, filepath });
            }

            // 2. Create a commit only if we have actual user changes
            const hasChanges = actuallyModifiedFiles.length > 0 || deletedFiles.length > 0;

            if (hasChanges) {
                const commitMessage = `Local changes: ${actuallyModifiedFiles.length} modified, ${deletedFiles.length} deleted`;
                console.log("Creating commit with message:", commitMessage);
                const commitSha = await this.commit(dir, commitMessage, author);
                console.log(`Created commit: ${commitSha}`);
            } else {
                console.log("No local changes to commit");
            }

            // 3. Fetch remote changes
            console.log("Fetching remote changes...");
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });
            console.log("Fetch completed");

            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }
            console.log(`Current branch: ${currentBranch}`);

            // Get remote ref and OIDs
            const remoteRef = `refs/remotes/origin/${currentBranch}`;
            const remoteOid = await git.resolveRef({ fs, dir, ref: remoteRef });
            const localOid = await git.resolveRef({ fs, dir, ref: currentBranch });
            console.log(`Local OID: ${localOid}, Remote OID: ${remoteOid}`);

            // Can we fast-forward?
            const canFastForward = await git.isDescendent({
                fs,
                dir,
                oid: remoteOid,
                ancestor: localOid,
            });
            console.log(`Can fast-forward? ${canFastForward}`);

            // If we can fast-forward, do it and push
            if (canFastForward) {
                console.log("Fast-forwarding local branch to remote");
                await git.writeRef({
                    fs,
                    dir,
                    ref: `refs/heads/${currentBranch}`,
                    value: remoteOid,
                    force: true,
                });
                await git.checkout({ fs, dir, ref: currentBranch });

                // Only push if we had local changes
                if (hasChanges) {
                    console.log("Pushing local changes to remote");
                    await this.push(dir, auth);
                    console.log("Push completed");
                } else {
                    console.log("No local changes to push");
                }
                console.log("=== syncChanges completed (fast-forward) ===");
                return { hadConflicts: false };
            }

            console.log("Cannot fast-forward, checking for conflicts");

            // Non-fast-forward case: check for conflicts
            const modifiedFiles = this.getModifiedFiles(status);
            console.log("Files that might have conflicts:", modifiedFiles);

            if (modifiedFiles.length > 0) {
                console.log("Checking for conflicts in modified files");
                const conflicts = await Promise.all(
                    modifiedFiles.map(async (filepath) => {
                        try {
                            // Get all versions of the file
                            const ours = await this.readFileContent(dir, filepath).catch(() => "");
                            const theirs = await this.readRemoteContent(
                                dir,
                                filepath,
                                remoteOid
                            ).catch(() => "");
                            const base = await this.getBaseVersion(
                                dir,
                                filepath,
                                localOid,
                                remoteOid
                            ).catch(() => "");

                            // Only consider it a conflict if the content actually differs
                            // and at least one version exists
                            if ((ours || theirs) && ours !== theirs) {
                                console.log(`Conflict detected in file: ${filepath}`);
                                return {
                                    filepath,
                                    ours,
                                    theirs,
                                    base,
                                };
                            }
                            console.log(`No conflict in file: ${filepath}`);
                            return null;
                        } catch (error) {
                            console.error(`Error processing file ${filepath}:`, error);
                            return null;
                        }
                    })
                );

                // Filter out null entries and files that aren't actually conflicts
                const validConflicts = conflicts.filter(
                    (conflict): conflict is ConflictedFile => conflict !== null
                );

                console.log(`Found ${validConflicts.length} conflicts that need resolution`);

                // Return conflicts to let client handle resolution
                console.log("=== syncChanges completed (with conflicts) ===");
                return {
                    hadConflicts: validConflicts.length > 0,
                    needsMerge: true,
                    localOid,
                    remoteOid,
                    conflicts: validConflicts,
                };
            }

            console.log("No conflicts found, but merge is needed");
            console.log("=== syncChanges completed (needs merge) ===");
            // No conflicts but needs merge
            return {
                hadConflicts: false,
                needsMerge: true,
                localOid,
                remoteOid,
            };
        } catch (error) {
            console.error("Error syncing changes:", error);
            throw error;
        }
    }

    private async collectConflicts(
        dir: string,
        conflictPaths: string[],
        remoteBranch: string
    ): Promise<ConflictedFile[]> {
        try {
            const localOid = await git.resolveRef({
                fs,
                dir,
                ref: (await git.currentBranch({ fs, dir })) || "main",
            });
            const remoteOid = await git.resolveRef({ fs, dir, ref: remoteBranch });

            const conflicts = await Promise.all(
                conflictPaths.map(async (filepath) => {
                    try {
                        return {
                            filepath,
                            ours: await this.readFileContent(dir, filepath),
                            theirs: await this.readRemoteContent(dir, filepath, remoteOid),
                            base: await this.getBaseVersion(dir, filepath, localOid, remoteOid),
                        };
                    } catch (error) {
                        console.error(`Error processing conflict for ${filepath}:`, error);
                        return {
                            filepath,
                            ours: "",
                            theirs: "",
                            base: "",
                        };
                    }
                })
            );

            // Filter out any files that failed to process
            return conflicts.filter((c) => c.ours !== "" || c.theirs !== "");
        } catch (error) {
            console.error("Error collecting conflicts:", error);
            return [];
        }
    }

    private async getBaseVersion(
        dir: string,
        filepath: string,
        localOid: string,
        remoteOid: string
    ): Promise<string> {
        try {
            const mergeBase = await git.findMergeBase({
                fs,
                dir,
                oids: [localOid, remoteOid],
            });

            if (!mergeBase?.[0]) {
                return "";
            }

            try {
                const { blob } = await git.readBlob({
                    fs,
                    dir,
                    oid: mergeBase[0],
                    filepath,
                });
                return new TextDecoder().decode(blob);
            } catch (error) {
                // File doesn't exist in base version - this is normal for new files
                console.log(`File ${filepath} doesn't exist in base version`);
                return "";
            }
        } catch (error) {
            console.error("Error getting base version:", error);
            return ""; // Return empty string for any errors
        }
    }

    // Helper methods
    private async readFileContent(dir: string, filepath: string): Promise<string> {
        const uri = vscode.Uri.file(path.join(dir, filepath));
        const content = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(content);
    }

    private async readRemoteContent(dir: string, filepath: string, oid: string): Promise<string> {
        try {
            const { blob } = await git.readBlob({
                fs,
                dir,
                oid,
                filepath,
            });
            return new TextDecoder().decode(blob);
        } catch (error) {
            // File doesn't exist in remote version
            console.log(`File ${filepath} doesn't exist in remote version`);
            return "";
        }
    }

    // Helper method to identify actually modified files from status matrix
    private getModifiedFiles(status: Array<[string, number, number, number]>): string[] {
        return status
            .filter(([_, head, workdir, stage]) => {
                // File is modified if:
                // 1. It's untracked (head === 0 && workdir === 1), or
                // 2. Working dir differs from HEAD (head === 1 && workdir === 1 && workdir !== head), or
                // 3. File is deleted (head === 1 && workdir === 0)
                return (
                    (head === 0 && workdir === 1) || // New file
                    (head === 1 && workdir === 1 && workdir !== head) || // Modified file
                    (head === 1 && workdir === 0) // Deleted file
                );
            })
            .map(([filepath]) => filepath);
    }
}

// Add new type definitions
export interface ConflictedFile {
    filepath: string;
    ours: string; // The actual content, not a path
    theirs: string; // The actual content, not a path
    base: string; // The actual content, not a path
}

// function mergeText(ours: string, theirs: string, base: string): string {
//     // Implement real 3-way merge using a library like diff3
//     // Or use isomorphic-git's mergeFile
//     const result = diff3.default(ours, base, theirs);
//     if (result.conflict) {
//         throw new Error(`Conflict in file: ${filepath}`);
//     }
//     return result.result;
// }
