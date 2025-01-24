import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";

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
                cancellable: false,
            },
            async (progress) => {
                try {
                    // Ensure we're on main branch
                    // TODO: Make branch configurable
                    const currentBranch = await this.getCurrentBranch(dir);
                    if (currentBranch !== "main") {
                        await git.branch({ fs, dir, ref: "main" });
                        await git.checkout({ fs, dir, ref: "main" });
                    }

                    const pushOptions = {
                        fs,
                        http,
                        dir,
                        remote: "origin",
                        ref: "main",
                        force: force,
                        onAuth: () => auth,
                        onProgress: (event: { phase?: string }) => {
                            if (event.phase) {
                                progress.report({
                                    message: event.phase,
                                    increment: 20,
                                });
                            }
                        },
                    };

                    try {
                        // Try normal push first
                        await git.push(pushOptions);
                    } catch (pushError) {
                        // console.log("Initial push failed, trying with force");
                        // If normal push fails, try with force again
                        await git.push({
                            ...pushOptions,
                            force: true,
                        });
                    }
                } catch (error) {
                    console.error("Push error:", error);
                    throw new Error(
                        `Failed to push changes: ${error instanceof Error ? error.message : "Unknown error"}`
                    );
                }
            }
        );
    }

    async pull(
        dir: string,
        auth: { username: string; password: string },
        author?: { name: string; email: string }
    ): Promise<{ hadConflicts: boolean; conflicts: ConflictedFile[] }> {
        console.log("RYDER: Pulling changes in .pull()...");
        let hadConflicts = false;
        const conflicts: ConflictedFile[] = [];

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Pulling changes...",
                cancellable: false,
            },
            async (progress) => {
                try {
                    if (author) {
                        await this.configureAuthor(dir, author.name, author.email);
                    }

                    console.log("RYDER: About to pull with config:", { dir, auth });

                    try {
                        await git.pull({
                            fs,
                            http,
                            dir,
                            onAuth: () => auth,
                            onProgress: (event) => {
                                if (event.phase) {
                                    progress.report({
                                        message: event.phase,
                                        increment: 20,
                                    });
                                }
                            },
                            fastForwardOnly: false,
                        });

                        // Check for merge conflicts after pull
                        const status = await this.getStatus(dir);
                        console.log("RYDER: Status after pull:", status);

                        if (status && Array.isArray(status)) {
                            const conflictedFiles = status
                                .filter(
                                    ([_, head, workdir, stage]) =>
                                        stage === 2 || (head === 2 && workdir === 1)
                                )
                                .map(([filepath]) => ({
                                    filepath,
                                    ours: `${dir}/.git/OUR_${filepath}`,
                                    theirs: `${dir}/.git/THEIR_${filepath}`,
                                    base: `${dir}/.git/BASE_${filepath}`,
                                }));

                            conflicts.push(...conflictedFiles);
                            hadConflicts = conflicts.length > 0;

                            console.log("RYDER: Conflict detection result:", {
                                hadConflicts,
                                conflicts,
                                statusLength: status.length,
                                conflictedFiles,
                            });
                        }
                    } catch (pullError) {
                        console.log("RYDER: Pull error:", pullError);

                        if (pullError instanceof git.Errors.MergeConflictError) {
                            console.log("RYDER: Merge conflict error data:", pullError.data);

                            const paths =
                                pullError.data?.filepaths || pullError.data?.filepaths || [];
                            if (Array.isArray(paths)) {
                                for (const filepath of paths) {
                                    try {
                                        const versions = await this.getConflictVersions(
                                            dir,
                                            filepath
                                        );
                                        conflicts.push({
                                            filepath,
                                            ...versions,
                                        });
                                    } catch (err) {
                                        console.error(
                                            `Failed to get versions for ${filepath}:`,
                                            err
                                        );
                                    }
                                }
                                hadConflicts = true;
                            }
                        } else {
                            throw pullError;
                        }
                    }
                } catch (error) {
                    console.error("Pull operation error:", error);
                    throw error;
                }
            }
        );

        console.log("RYDER: Pull operation completed:", { hadConflicts, conflicts });
        return { hadConflicts, conflicts };
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
}

// Add new type definitions
export interface ConflictedFile {
    filepath: string;
    ours: string; // The actual content, not a path
    theirs: string; // The actual content, not a path
    base: string; // The actual content, not a path
}
