import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";
import * as diff3 from "diff3";

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
        await Promise.all(
            status.map(([filepath, , worktreeStatus]) =>
                // Add if file is unstaged or modified
                worktreeStatus ? git.add({ fs, dir, filepath }) : Promise.resolve()
            )
        );
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
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Pushing changes...",
            },
            async (progress) => {
                try {
                    // Check for unmerged paths first
                    const status = await git.statusMatrix({ fs, dir });
                    const unmergedPaths = status
                        .filter(([, , , worktreeStatus]) => worktreeStatus === 3)
                        .map(([filepath]) => filepath);

                    if (unmergedPaths.length > 0) {
                        throw new Error(`Unmerged files detected: ${unmergedPaths.join(", ")}`);
                    }

                    // Rest of push logic...
                    const currentBranch = await this.getCurrentBranch(dir);

                    // First try to merge if needed
                    const localOid = await git.resolveRef({
                        fs,
                        dir,
                        ref: currentBranch || "main",
                    });
                    const remoteBranch = `origin/${currentBranch}`;
                    let remoteOid;
                    try {
                        remoteOid = await git.resolveRef({ fs, dir, ref: remoteBranch });
                    } catch {
                        // Remote ref doesn't exist yet
                        remoteOid = null;
                    }

                    console.log("RYDER: Push - Local:", localOid, "Remote:", remoteOid);

                    if (remoteOid && localOid !== remoteOid) {
                        // Branches have diverged, we need to merge first
                        try {
                            await git.merge({
                                fs,
                                dir,
                                ours: currentBranch || "main",
                                theirs: remoteBranch,
                                abortOnConflict: false,
                            });
                        } catch (err) {
                            if (err instanceof git.Errors.MergeConflictError) {
                                // We have conflicts that need manual resolution
                                const conflicts = await this.collectConflicts(
                                    dir,
                                    err.data.filepaths,
                                    remoteBranch
                                );
                                return {
                                    hadConflicts: true,
                                    needsMerge: true,
                                    conflicts,
                                    localOid,
                                    remoteOid,
                                };
                            }
                            throw err;
                        }
                    }

                    // Now try to push
                    const pushResult = await git.push({
                        fs,
                        http,
                        dir,
                        remote: "origin",
                        ref: currentBranch || "main",
                        force,
                        onAuth: () => ({
                            username: auth.username,
                            password: auth.password,
                        }),
                        onProgress: (event) => {
                            if (event.phase) {
                                progress.report({ message: event.phase });
                            }
                        },
                    });

                    // Verify the push
                    const finalRemoteOid = await git.resolveRef({ fs, dir, ref: remoteBranch });
                    console.log("RYDER: Push verification - Final remote:", finalRemoteOid);

                    if (finalRemoteOid !== localOid) {
                        throw new Error(
                            "Push verification failed - remote ref doesn't match local"
                        );
                    }

                    return { hadConflicts: false };
                } catch (error) {
                    console.error("Push error:", error);
                    throw error;
                }
            }
        );
    }

    async pull(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string }
    ): Promise<PullResult> {
        console.log("RYDER: Pulling changes in .pull()...");
        try {
            // First fetch the changes
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => ({
                    username: auth.username,
                    password: auth.password,
                }),
            });

            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // Get remote ref and OIDs
            const remoteRef = `refs/remotes/origin/${currentBranch}`;
            const remoteOid = await git.resolveRef({ fs, dir, ref: remoteRef });
            const localOid = await git.resolveRef({ fs, dir, ref: currentBranch });

            // Simple check: Are histories diverged?
            const canFastForward = await git.isDescendent({
                fs,
                dir,
                oid: remoteOid,
                ancestor: localOid,
            });

            // If we can fast-forward, do it
            if (canFastForward) {
                console.log("RYDER: No conflicts, fast-forwarding...");
                await git.writeRef({
                    fs,
                    dir,
                    ref: `refs/heads/${currentBranch}`,
                    value: remoteOid,
                    force: true,
                });
                await git.checkout({ fs, dir, ref: currentBranch, force: true });
                return { hadConflicts: false };
            }

            // Get modified files from status, excluding .git/* paths
            const statusMatrix = await git.statusMatrix({ fs, dir });
            const modifiedFiles = statusMatrix
                .filter(
                    ([filepath, head, workdir, stage]) =>
                        // Only include files that are modified
                        (workdir !== stage || head !== stage) &&
                        // Exclude .git/* paths
                        !filepath.startsWith(".git/")
                )
                .map(([filepath]) => filepath);

            console.log("RYDER: Modified files:", modifiedFiles);

            // Create conflicts list from real file conflicts
            const conflicts: ConflictedFile[] = [];

            if (modifiedFiles.length > 0) {
                for (const filepath of modifiedFiles) {
                    conflicts.push({
                        filepath,
                        ours: await this.readFileContent(dir, filepath),
                        theirs: await this.readRemoteContent(dir, filepath, remoteOid),
                        base: await this.getBaseVersion(dir, filepath, localOid, remoteOid),
                    });
                }
            }

            // Return both merge status and any file conflicts
            return {
                hadConflicts: conflicts.length > 0,
                needsMerge: !canFastForward,
                localOid,
                remoteOid,
                conflicts: conflicts.length > 0 ? conflicts : undefined,
            };
        } catch (error) {
            console.error("Pull operation error:", error);
            throw error;
        }
    }

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
        } catch (err) {
            console.error(`Error reading remote content for ${filepath}:`, err);
            return "";
        }
    }

    async getStatus(dir: string): Promise<Array<[string, number, number, number]>> {
        return git.statusMatrix({ fs, dir });
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

            // console.log("Git repository initialized at:", dir);
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
            // console.log("Added remote:", name, url);
        } catch (error) {
            // If remote already exists, try to update it
            if (error instanceof Error && error.message.includes("already exists")) {
                await git.deleteRemote({ fs, dir, remote: name });
                await git.addRemote({ fs, dir, remote: name, url });
                // console.log("Updated existing remote:", name, url);
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

    /**
     * Notes:
     * We trust that the client has resolved the files in the working tree before calling completeMerge.
     * We stage those resolved files.
     * We create a proper two-parent commit that merges both the local and remote branches.
     * We push that merge commit up to the remote.
     * This ensures Git sees a true merge, retaining both branches' histories.
     *
     * @param dir - The directory of the git repository
     * @param auth - The authentication object
     * @param author - The author object
     * @param resolvedFiles - The list of files (relative paths) that have been resolved
     */
    async completeMerge(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string },
        resolvedFiles: string[]
    ): Promise<void> {
        try {
            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            const remoteBranch = `origin/${currentBranch}`;

            // Stage all previously-conflicting files, now resolved in the working tree
            for (const file of resolvedFiles) {
                await git.add({ fs, dir, filepath: file });
            }

            // Create the merge commit. We specify the parent commits explicitly
            // for a proper two-parent merge in Git history:
            const localOid = await git.resolveRef({ fs, dir, ref: currentBranch });
            const remoteOid = await git.resolveRef({ fs, dir, ref: remoteBranch });

            await git.commit({
                fs,
                dir,
                message: `Merge branch '${remoteBranch}' into ${currentBranch}\n\nResolved conflicts:\n${resolvedFiles.join("\n")}`,
                author,
                parent: [localOid, remoteOid],
            });

            console.log("RYDER: Local merge commit created. Now pushing...");

            // Push the merge commit to remote
            await git.push({
                fs,
                http,
                dir,
                ...auth,
                ref: currentBranch,
            });

            console.log("RYDER: Merge completed and pushed successfully");
        } catch (error) {
            console.error("Error completing merge:", error);
            throw error;
        }
    }

    async syncChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string }
    ): Promise<void> {
        try {
            // First pull changes
            const pullResult = await this.pull(dir, auth, author);

            if (pullResult.needsMerge) {
                if (pullResult.conflicts) {
                    // If there are file conflicts, let the client handle them
                    console.log("RYDER: File conflicts need manual resolution");
                    throw new Error("File conflicts need manual resolution");
                } else {
                    // Automatic merge of divergent histories with no file conflicts
                    console.log("RYDER: Performing automatic merge of divergent histories");
                    await this.completeMerge(dir, auth, author, []);
                }
            }

            // Push any local changes
            await this.push(dir, auth);
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
        const localOid = await git.resolveRef({
            fs,
            dir,
            ref: (await git.currentBranch({ fs, dir })) || "main",
        });
        const remoteOid = await git.resolveRef({ fs, dir, ref: remoteBranch });

        return Promise.all(
            conflictPaths.map(async (filepath) => ({
                filepath,
                ours: await this.readFileContent(dir, filepath),
                theirs: await this.readRemoteContent(dir, filepath, remoteOid),
                base: await this.getBaseVersion(dir, filepath, localOid, remoteOid),
            }))
        );
    }

    private async getBaseVersion(
        dir: string,
        filepath: string,
        localOid: string,
        remoteOid: string
    ): Promise<string> {
        try {
            // Find common ancestor
            const mergeBase = await git.findMergeBase({
                fs,
                dir,
                oids: [localOid, remoteOid],
            });

            if (!mergeBase) {
                return "";
            }

            // Get file content at merge base
            const { blob } = await git.readBlob({
                fs,
                dir,
                oid: mergeBase[0],
                filepath,
            });

            return new TextDecoder().decode(blob);
        } catch {
            return "";
        }
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
