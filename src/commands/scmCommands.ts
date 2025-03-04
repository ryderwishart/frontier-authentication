import * as vscode from "vscode";
import { SCMManager } from "../scm/SCMManager";
import { GitLabService } from "../gitlab/GitLabService";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";

export interface PublishWorkspaceOptions {
    name: string;
    description?: string;
    visibility: "private" | "public";
    groupId: string;
    force?: boolean;
}

export function registerSCMCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider
) {
    const gitLabService = new GitLabService(authProvider);
    const scmManager = new SCMManager(gitLabService, context);

    // Register list projects command
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.listProjects", async ({ showUI = true } = {}) => {
            // console.log("Listing projects...");
            try {
                await gitLabService.initialize();
                const projects = await gitLabService.listProjects({
                    orderBy: "last_activity_at",
                    sort: "desc",
                });

                // Transform projects into a consistent return format
                const formattedProjects = projects.map((project) => ({
                    id: project.id,
                    name: project.name,
                    description: project.description,
                    visibility: project.visibility,
                    url: project.http_url_to_repo,
                    webUrl: project.web_url,
                    lastActivity: project.last_activity_at,
                    namespace: project.namespace.full_path,
                    owner: project.owner?.name || project.namespace.name,
                }));

                if (!showUI) {
                    return formattedProjects;
                }

                if (projects.length === 0) {
                    vscode.window.showInformationMessage("No projects found.");
                    return [];
                }

                // Show projects in QuickPick
                const selectedProject = await vscode.window.showQuickPick(
                    projects.map((project) => ({
                        label: project.name,
                        description: project.description || "",
                        detail: `Last activity: ${new Date(
                            project.last_activity_at
                        ).toLocaleDateString()} | Owner: ${
                            project.owner?.name || project.namespace.name
                        }`,
                        project: project,
                    })),
                    {
                        placeHolder: "Select a project to view details",
                        matchOnDescription: true,
                        matchOnDetail: true,
                    }
                );

                if (selectedProject) {
                    // Show project details
                    const detailsMessage = [
                        `Name: ${selectedProject.project.name}`,
                        `Description: ${selectedProject.project.description || "No description"}`,
                        `Visibility: ${selectedProject.project.visibility}`,
                        `URL: ${selectedProject.project.web_url}`,
                        `Last Activity: ${new Date(
                            selectedProject.project.last_activity_at
                        ).toLocaleString()}`,
                        `Owner: ${
                            selectedProject.project.owner?.name ||
                            selectedProject.project.namespace.name
                        }`,
                    ].join("\n");

                    const action = await vscode.window.showInformationMessage(
                        detailsMessage,
                        "Clone Repository"
                    );

                    if (action === "Clone Repository") {
                        await vscode.commands.executeCommand(
                            "frontier.cloneRepository",
                            selectedProject.project.http_url_to_repo
                        );
                    }
                }

                return formattedProjects;
            } catch (error) {
                if (showUI) {
                    vscode.window.showErrorMessage(
                        `Failed to list projects: ${
                            error instanceof Error ? error.message : "Unknown error"
                        }`
                    );
                }
                return [];
            }
        })
    );

    // Register create and clone project command
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.createAndCloneProject", async () => {
            try {
                // Get project name
                const name = await vscode.window.showInputBox({
                    prompt: "Enter project name",
                    validateInput: (value: string) => {
                        if (!value) {
                            return "Project name is required";
                        }
                        if (!/^[\w.-]+$/.test(value)) {
                            return "Invalid project name";
                        }
                        return null;
                    },
                });
                if (!name) {
                    return;
                }

                // Get description (optional)
                const description = await vscode.window.showInputBox({
                    prompt: "Enter project description (optional)",
                });

                // Get visibility
                const visibility = (await vscode.window.showQuickPick(
                    ["private", "internal", "public"],
                    { placeHolder: "Select project visibility" }
                )) as "private" | "internal" | "public" | undefined;
                if (!visibility) {
                    return;
                }

                // Try to create as personal project first
                try {
                    await scmManager.createAndCloneProject({
                        name,
                        description,
                        visibility,
                    });
                } catch (error) {
                    // If personal project creation fails, try with group
                    if (
                        error instanceof Error &&
                        !error.message.includes("authentication failed")
                    ) {
                        const groups = await gitLabService.listGroups();
                        if (groups.length > 0) {
                            const selectedGroup = await vscode.window.showQuickPick(
                                groups.map((group) => ({
                                    label: group.name,
                                    description: group.path,
                                    id: group.id.toString(),
                                })),
                                {
                                    placeHolder: "Select a group",
                                }
                            );

                            if (selectedGroup) {
                                await scmManager.createAndCloneProject({
                                    name,
                                    description,
                                    visibility,
                                    groupId: selectedGroup.id,
                                });
                                return;
                            }
                        }
                    }
                    throw error;
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to create project: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
            }
        })
    );

    // Get all groups the user is at least a member of
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.listGroupsUserIsAtLeastMemberOf", async () => {
            const groups = await gitLabService.listGroups();
            return groups as {
                id: string;
                name: string;
                path: string;
            }[];
        })
    );

    // Register clone existing repository command
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "frontier.cloneRepository",
            async (repositoryUrl?: string, cloneToPath?: string) => {
                try {
                    if (!repositoryUrl) {
                        repositoryUrl = await vscode.window.showInputBox({
                            prompt: "Enter GitLab repository URL",
                            validateInput: (value: string) => {
                                if (!value) {
                                    return "Repository URL is required";
                                }
                                if (!value.startsWith("http")) {
                                    return "Please enter an HTTPS URL";
                                }
                                return null;
                            },
                        });
                    }

                    if (repositoryUrl) {
                        await scmManager.cloneExistingRepository(repositoryUrl, cloneToPath);
                    }
                    return true;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to clone repository: ${
                            error instanceof Error ? error.message : "Unknown error"
                        }`
                    );
                    return false;
                }
            }
        )
    );

    // Register publish workspace command
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "frontier.publishWorkspace",
            async (options?: {
                name: string;
                description?: string;
                visibility?: "private" | /* "internal" | */ "public";
                groupId?: string;
                force?: boolean;
            }) => {
                try {
                    await gitLabService.initialize();

                    // Get project name from workspace folder
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) {
                        throw new Error("No workspace folder found");
                    }
                    const defaultName = workspaceFolder.name;

                    // Prompt for project details
                    const name =
                        options?.name ||
                        (await vscode.window.showInputBox({
                            prompt: "Enter project name",
                            value: defaultName,
                            validateInput: (value) => {
                                if (!value) {
                                    return "Project name is required";
                                }
                                return null;
                            },
                        }));

                    if (!name) {
                        return; // User cancelled
                    }

                    const description =
                        options?.description ||
                        (await vscode.window.showInputBox({
                            prompt: "Enter project description (optional)",
                        }));

                    const visibility =
                        options?.visibility ||
                        (await vscode.window
                            .showQuickPick(
                                [
                                    { label: "Private", value: "private" },
                                    // { label: "Internal", value: "internal" },
                                    { label: "Public", value: "public" },
                                ],
                                {
                                    placeHolder: "Select project visibility",
                                }
                            )
                            .then((selected) => {
                                return selected?.value;
                            }));

                    if (!visibility) {
                        return; // User cancelled
                    }

                    const groups = await gitLabService.listGroups();

                    const groupId =
                        options?.groupId ||
                        (await vscode.window
                            .showQuickPick(
                                groups.map((group) => ({
                                    label: group.name,
                                    description: group.path,
                                    id: group.id.toString(),
                                })),
                                {
                                    placeHolder: "Select a group",
                                }
                            )
                            .then((selected) => {
                                return selected?.id;
                            }));

                    if (!groupId) {
                        return; // User cancelled
                    }

                    // Publish workspace
                    await scmManager.publishWorkspace({
                        name,
                        description,
                        visibility: visibility as "private" /* | "internal" */ | "public",
                        groupId: groupId,
                        force: options?.force || false,
                    });
                } catch (error) {
                    if (error instanceof Error) {
                        vscode.window.showErrorMessage(
                            `Failed to publish workspace: ${error.message}`
                        );
                    }
                }
            }
        )
    );
}
