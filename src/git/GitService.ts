import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { fs } from 'memfs';
import * as vscode from 'vscode';
import * as path from 'path';

export class GitService {
    constructor() {
        // Initialize the filesystem if needed
        if (!fs.existsSync('/')) {
            fs.mkdirSync('/', { recursive: true });
        }
    }

    async clone(
        url: string,
        dir: string,
        auth?: { username: string; password: string }
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Cloning repository...',
                cancellable: false
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
                            if (event.phase === 'Receiving objects') {
                                progress.report({
                                    message: `${event.phase}: ${event.loaded}/${event.total} objects`,
                                    increment: (event.loaded / event.total) * 100
                                });
                            }
                        },
                        ...(auth && {
                            onAuth: () => auth
                        })
                    });
                } catch (error) {
                    console.error('Clone error:', error);
                    throw new Error(`Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

    async commit(dir: string, message: string, author: { name: string; email: string }): Promise<string> {
        const sha = await git.commit({
            fs,
            dir,
            message,
            author
        });
        return sha;
    }

    async push(
        dir: string,
        auth: { username: string; password: string }
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Pushing changes...',
                cancellable: false
            },
            async (progress) => {
                try {
                    await git.push({
                        fs,
                        http,
                        dir,
                        onAuth: () => auth,
                        onProgress: (event) => {
                            if (event.phase) {
                                progress.report({
                                    message: event.phase,
                                    increment: 20
                                });
                            }
                        }
                    });
                } catch (error) {
                    console.error('Push error:', error);
                    throw new Error(`Failed to push changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
        );
    }

    async pull(
        dir: string,
        auth: { username: string; password: string }
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Pulling changes...',
                cancellable: false
            },
            async (progress) => {
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
                                    increment: 20
                                });
                            }
                        }
                    });
                } catch (error) {
                    console.error('Pull error:', error);
                    throw new Error(`Failed to pull changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
        );
    }

    async getStatus(dir: string): Promise<Array<[string, number, number, number]>> {
        return git.statusMatrix({ fs, dir });
    }

    async getCurrentBranch(dir: string): Promise<string> {
        return git.currentBranch({ fs, dir }) || 'main';
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
}
