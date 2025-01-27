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
        await Promise.all(
            status.map(([filepath, head, workdir, stage]) => {
                // Only add if file is:
                // - untracked (head === 0 && workdir === 1)
                // - modified (workdir !== head)
                // - staged but modified again (stage !== workdir)
                if ((head === 0 && workdir === 1) || workdir !== head || stage !== workdir) {
                    return git.add({ fs, dir, filepath });
                }
                return Promise.resolve();
            })
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

    async push(dir: string, auth: { username: string; password: string }): Promise<PushResult> {
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
            const modifiedFiles = status
                .filter(([filepath, head, workdir, stage]) => {
                    // Only include files that:
                    // 1. Exist in both local and remote (head === 1)
                    // 2. Have local modifications (workdir !== stage || head !== stage)
                    return head === 1 && (workdir !== stage || head !== stage);
                })
                .map(([filepath]) => filepath);

            // If we have potentially conflicting files, get their versions
            if (modifiedFiles.length > 0) {
                const conflicts = await Promise.all(
                    modifiedFiles.map(async (filepath) => ({
                        filepath,
                        ours: await this.readFileContent(dir, filepath),
                        theirs: await this.readRemoteContent(dir, filepath, remoteOid),
                        base: await this.getBaseVersion(dir, filepath, localOid, remoteOid),
                    }))
                );

                return {
                    hadConflicts: true,
                    needsMerge: true,
                    localOid,
                    remoteOid,
                    conflicts,
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

    async completeMerge(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string },
        resolvedFiles: string[]
    ): Promise<void> {
        const currentBranch = await git.currentBranch({ fs, dir });
        if (!currentBranch) {
            throw new Error("Not on any branch");
        }

        // Configure author before committing
        await this.configureAuthor(dir, author.name, author.email);

        // Stage all resolved files
        for (const file of resolvedFiles) {
            await git.add({ fs, dir, filepath: file });
        }

        // Create merge commit with both parents
        const localOid = await git.resolveRef({ fs, dir, ref: currentBranch });
        const remoteOid = await git.resolveRef({
            fs,
            dir,
            ref: `refs/remotes/origin/${currentBranch}`,
        });

        await git.commit({
            fs,
            dir,
            message: `Merge branch 'origin/${currentBranch}'\n\nResolved conflicts:\n${resolvedFiles.join("\n")}`,
            author: {
                name: author.name,
                email: author.email,
                timestamp: Math.floor(Date.now() / 1000),
                timezoneOffset: new Date().getTimezoneOffset(),
            },
            parent: [localOid, remoteOid],
        });

        // Push the merge commit with auth
        await this.push(dir, auth);
    }

    async syncChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string }
    ): Promise<PullResult> {
        try {
            // 1. Stage any local changes first
            await this.addAll(dir);

            // 2. Create a commit if we have staged changes
            const status = await git.statusMatrix({ fs, dir });
            const hasChanges = status.some(
                ([_, head, workdir, stage]) => stage !== head || workdir !== head
            );

            if (hasChanges) {
                await this.commit(dir, "Local changes", author);
            }

            // 3. Fetch remote changes
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

            // If we can fast-forward, do it and push
            if (canFastForward) {
                await git.writeRef({
                    fs,
                    dir,
                    ref: `refs/heads/${currentBranch}`,
                    value: remoteOid,
                    force: true,
                });
                await git.checkout({ fs, dir, ref: currentBranch });
                await this.push(dir, auth);
                return { hadConflicts: false };
            }

            // Non-fast-forward case: check for conflicts
            const modifiedFiles = status
                .filter(([filepath, head]) => head === 1) // Only existing files
                .map(([filepath]) => filepath);

            if (modifiedFiles.length > 0) {
                const conflicts = await Promise.all(
                    modifiedFiles.map(async (filepath) => ({
                        filepath,
                        ours: await this.readFileContent(dir, filepath),
                        theirs: await this.readRemoteContent(dir, filepath, remoteOid),
                        base: await this.getBaseVersion(dir, filepath, localOid, remoteOid),
                    }))
                );

                // Return conflicts to let client handle resolution
                return {
                    hadConflicts: true,
                    needsMerge: true,
                    localOid,
                    remoteOid,
                    conflicts,
                };
            }

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
        const mergeBase = await git.findMergeBase({
            fs,
            dir,
            oids: [localOid, remoteOid],
        });

        if (!mergeBase?.[0]) {
            return "";
        }

        const { blob } = await git.readBlob({
            fs,
            dir,
            oid: mergeBase[0],
            filepath,
        });

        return new TextDecoder().decode(blob);
    }

    // Helper methods
    private async readFileContent(dir: string, filepath: string): Promise<string> {
        const uri = vscode.Uri.file(path.join(dir, filepath));
        const content = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(content);
    }

    private async readRemoteContent(dir: string, filepath: string, oid: string): Promise<string> {
        const { blob } = await git.readBlob({
            fs,
            dir,
            oid,
            filepath,
        });
        return new TextDecoder().decode(blob);
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
