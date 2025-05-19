import * as vscode from "vscode";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";
import { GitLabService } from "../gitlab/GitLabService";

export function registerGitLabCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider
) {
    const gitlabService = new GitLabService(authProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.createGitLabProject", async () => {
            try {
                await gitlabService.initializeWithRetry();

                // Get project name from user
                const name = await vscode.window.showInputBox({
                    placeHolder: "Project name",
                    prompt: "Enter the name for your new GitLab project",
                    validateInput: (value) => {
                        return value.trim() ? null : "Project name is required";
                    },
                });

                if (!name) {
                    return; // User canceled
                }

                // Get project description (optional)
                const description = await vscode.window.showInputBox({
                    placeHolder: "Project description (optional)",
                    prompt: "Enter a description for your project",
                });

                // Get visibility
                const visibility = await vscode.window.showQuickPick(
                    ["private", "internal", "public"],
                    {
                        placeHolder: "Select project visibility",
                        canPickMany: false,
                    }
                );

                if (!visibility) {
                    return; // User canceled
                }

                // Try to create as personal project first
                try {
                    const project = await gitlabService.createProject({
                        name,
                        description,
                        visibility: visibility as "private" | "internal" | "public",
                        // Don't specify groupId for personal projects
                    });

                    vscode.window.showInformationMessage(
                        `Project created successfully! URL: ${project.url}`
                    );
                    return;
                } catch (error) {
                    // If personal project creation fails, try with group
                    // Only if the error isn't about authentication
                    if (
                        error instanceof Error &&
                        !error.message.includes("authentication failed")
                    ) {
                        const groups = await gitlabService.listGroups();

                        // Only proceed with group selection if we have groups
                        if (groups.length > 0) {
                            const selectedGroup = await vscode.window.showQuickPick(
                                groups.map((group) => ({ label: group.name, id: group.id })),
                                {
                                    placeHolder:
                                        "Personal project creation failed. Select a group to try there instead",
                                    title: "Select Group",
                                }
                            );

                            if (selectedGroup) {
                                const project = await gitlabService.createProject({
                                    name,
                                    description,
                                    visibility: visibility as "private" | "internal" | "public",
                                    groupId: selectedGroup.id.toString(),
                                });

                                vscode.window.showInformationMessage(
                                    `Project created successfully! URL: ${project.url}`
                                );
                                return;
                            }
                        }
                    }
                    // If we get here, both attempts failed or were cancelled
                    throw error;
                }
            } catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(`Failed to create project: ${error.message}`);
                }
            }
        })
    );
}
