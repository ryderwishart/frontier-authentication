import * as vscode from "vscode";
import * as path from "path";
import { GitService } from "../git/GitService";
import { GitLabService } from "../gitlab/GitLabService";

/**
 * Register all LFS-related commands
 */
export function registerLFSCommands(
    context: vscode.ExtensionContext,
    gitService: GitService,
    gitLabService: GitLabService
) {
    // Initialize Git LFS for current repository
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.initializeLFS", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            try {
                // Check if repository exists
                const hasGit = await gitService.hasGitRepository(workspacePath);
                if (!hasGit) {
                    vscode.window.showErrorMessage("No Git repository found in workspace");
                    return;
                }

                // Check if LFS is already enabled
                const isEnabled = await gitService.isLFSEnabled(workspacePath);
                if (isEnabled) {
                    vscode.window.showInformationMessage(
                        "Git LFS is already enabled for this repository"
                    );
                    return;
                }

                // Get user info for commit
                const userInfo = await gitLabService.getUserInfo();

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Initializing Git LFS...",
                        cancellable: false,
                    },
                    async () => {
                        await gitService.initializeLFS(workspacePath, {
                            name: userInfo.username,
                            email: userInfo.email,
                        });
                    }
                );

                vscode.window.showInformationMessage(
                    "✅ Git LFS initialized! All multimedia files will now be stored efficiently."
                );
            } catch (error) {
                console.error("[LFS Commands] Failed to initialize LFS:", error);
                vscode.window.showErrorMessage(
                    `Failed to initialize LFS: ${error instanceof Error ? error.message : "Unknown error"}`
                );
            }
        })
    );

    // Migrate existing large files to LFS
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.migrateLargeFiles", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            try {
                // Check if repository exists
                const hasGit = await gitService.hasGitRepository(workspacePath);
                if (!hasGit) {
                    vscode.window.showErrorMessage("No Git repository found in workspace");
                    return;
                }

                // Find files that could benefit from LFS
                const candidates = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Scanning for large files...",
                        cancellable: false,
                    },
                    async () => {
                        return await gitService.findLFSCandidates(workspacePath);
                    }
                );

                if (candidates.length === 0) {
                    vscode.window.showInformationMessage(
                        "No large files found that would benefit from Git LFS"
                    );
                    return;
                }

                // Show migration dialog
                const shouldMigrate = await showMigrationDialog(candidates);
                if (!shouldMigrate) {
                    return;
                }

                // Perform migration
                const userInfo = await gitLabService.getUserInfo();

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Migrating ${candidates.length} files to LFS...`,
                        cancellable: false,
                    },
                    async () => {
                        await gitService.migrateFilesToLFS(workspacePath, candidates, {
                            name: userInfo.username,
                            email: userInfo.email,
                        });
                    }
                );

                vscode.window.showInformationMessage(
                    `✅ Successfully migrated ${candidates.length} files to Git LFS`
                );
            } catch (error) {
                console.error("[LFS Commands] Migration failed:", error);
                vscode.window.showErrorMessage(
                    `Migration failed: ${error instanceof Error ? error.message : "Unknown error"}`
                );
            }
        })
    );

    // Show LFS status
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.lfsStatus", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            try {
                // Check if repository exists
                const hasGit = await gitService.hasGitRepository(workspacePath);
                if (!hasGit) {
                    vscode.window.showErrorMessage("No Git repository found in workspace");
                    return;
                }

                const isEnabled = await gitService.isLFSEnabled(workspacePath);
                if (!isEnabled) {
                    const choice = await vscode.window.showInformationMessage(
                        "Git LFS is not enabled for this repository. Would you like to enable it?",
                        "Enable LFS",
                        "Cancel"
                    );

                    if (choice === "Enable LFS") {
                        await vscode.commands.executeCommand("frontier.initializeLFS");
                    }
                    return;
                }

                // Get LFS status
                const status = await gitService.getLFSStatus(workspacePath);

                const statusMessage = `Git LFS Status for ${path.basename(workspacePath)}:

✅ LFS Enabled
📁 Tracked patterns: ${status.trackedPatterns.length}
📄 LFS files: ${status.lfsFiles.length}
💾 Total LFS size: ${formatBytes(status.totalSize)}

Tracked Patterns:
${status.trackedPatterns.slice(0, 10).join(", ")}${status.trackedPatterns.length > 10 ? `\n... and ${status.trackedPatterns.length - 10} more` : ""}

LFS Files:
${status.lfsFiles.slice(0, 5).join("\n")}${status.lfsFiles.length > 5 ? `\n... and ${status.lfsFiles.length - 5} more` : ""}`;

                // Show in new document for better readability
                const doc = await vscode.workspace.openTextDocument({
                    content: statusMessage,
                    language: "plaintext",
                });
                await vscode.window.showTextDocument(doc);
            } catch (error) {
                console.error("[LFS Commands] Failed to get LFS status:", error);
                vscode.window.showErrorMessage(
                    `Failed to get LFS status: ${error instanceof Error ? error.message : "Unknown error"}`
                );
            }
        })
    );

    // Force LFS for specific file types
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.addFileTypeToLFS", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            try {
                // Check if LFS is enabled
                const isEnabled = await gitService.isLFSEnabled(workspacePath);
                if (!isEnabled) {
                    const choice = await vscode.window.showInformationMessage(
                        "Git LFS is not enabled. Enable it first?",
                        "Enable LFS",
                        "Cancel"
                    );

                    if (choice === "Enable LFS") {
                        await vscode.commands.executeCommand("frontier.initializeLFS");
                    }
                    return;
                }

                // Ask for file extension
                const extension = await vscode.window.showInputBox({
                    prompt: "Enter file extension to add to LFS (e.g., .mov, .zip)",
                    placeHolder: ".mov",
                    validateInput: (value) => {
                        if (!value || !value.startsWith(".")) {
                            return "Extension must start with a dot (e.g., .mov)";
                        }
                        return null;
                    },
                });

                if (!extension) {
                    return;
                }

                // Add to LFS patterns
                const dummyFilePath = `dummy${extension}`;
                await gitService["lfsService"].addFileTypeToLFS(workspacePath, dummyFilePath);

                vscode.window.showInformationMessage(
                    `✅ Added ${extension} files to Git LFS patterns`
                );
            } catch (error) {
                console.error("[LFS Commands] Failed to add file type:", error);
                vscode.window.showErrorMessage(
                    `Failed to add file type: ${error instanceof Error ? error.message : "Unknown error"}`
                );
            }
        }),

        vscode.commands.registerCommand("frontier.testLFSConnectivity", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            try {
                vscode.window.showInformationMessage("Testing LFS connectivity...");

                // Get the credentials and HTTP client like the actual LFS operations do
                const auth = await gitService.getLFSAuth();
                const http = (await import("isomorphic-git/http/web")).default;
                const lfsService = gitService.getLFSService();

                // Get remote URL
                const git = await import("isomorphic-git");
                const fs = await import("fs");
                const remoteURL = await git.getConfig({
                    fs,
                    dir: workspacePath,
                    path: "remote.origin.url",
                });

                if (!remoteURL) {
                    vscode.window.showErrorMessage("No remote origin configured");
                    return;
                }

                const cleanURL = remoteURL.replace(/^https?:\/\/[^@]*@/, "https://");

                // Test connectivity
                const isConnected = await lfsService.testLFSConnectivity(cleanURL, http, auth);

                if (isConnected) {
                    vscode.window.showInformationMessage(
                        `✅ LFS server is accessible at ${cleanURL}`
                    );
                } else {
                    vscode.window.showWarningMessage(
                        `❌ Cannot connect to LFS server at ${cleanURL}. Check if LFS is enabled on the repository.`
                    );
                }
            } catch (error) {
                console.error("[LFS Commands] Error testing LFS connectivity:", error);
                vscode.window.showErrorMessage(`LFS connectivity test failed: ${error}`);
            }
        })
    );
}

/**
 * Show migration dialog with file list
 */
async function showMigrationDialog(candidates: string[]): Promise<boolean> {
    const fileList = candidates.slice(0, 10).join("\n• ");
    const moreFiles =
        candidates.length > 10 ? `\n• ... and ${candidates.length - 10} more files` : "";

    const message = `Found ${candidates.length} large files that could benefit from Git LFS:

• ${fileList}${moreFiles}

Migrating to LFS will:
✅ Reduce repository size
✅ Improve clone and fetch performance
✅ Keep multimedia files organized
⚠️  Require other contributors to have LFS enabled

Continue with migration?`;

    const choice = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        "Yes, migrate files",
        "No, keep as regular Git files"
    );

    return choice === "Yes, migrate files";
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) {
        return "0 Bytes";
    }

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Check if workspace has multimedia files that would benefit from LFS
 */
export async function hasMultimediaFiles(
    workspacePath: string,
    gitService: GitService
): Promise<boolean> {
    try {
        const candidates = await gitService.findLFSCandidates(workspacePath);
        return candidates.length > 0;
    } catch (error) {
        console.debug("[LFS Commands] Could not check for multimedia files:", error);
        return false;
    }
}
