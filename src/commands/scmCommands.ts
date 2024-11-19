import * as vscode from 'vscode';
import { SCMManager } from '../scm/SCMManager';
import { GitLabService } from '../gitlab/GitLabService';
import { FrontierAuthProvider } from '../auth/AuthenticationProvider';

export function registerSCMCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider
) {
    const gitLabService = new GitLabService(authProvider);
    const scmManager = new SCMManager(gitLabService, context);

    // Register list projects command
    context.subscriptions.push(
        vscode.commands.registerCommand('frontier.listProjects', async () => {
            console.log('Listing projects...');
            try {
                await gitLabService.initialize();
                const projects = await gitLabService.listProjects({
                    orderBy: 'last_activity_at',
                    sort: 'desc'
                });

                if (projects.length === 0) {
                    vscode.window.showInformationMessage('No projects found.');
                    return;
                }

                // Show projects in QuickPick
                const selectedProject = await vscode.window.showQuickPick(
                    projects.map(project => ({
                        label: project.name,
                        description: project.description || '',
                        detail: `Last activity: ${new Date(project.last_activity_at).toLocaleDateString()} | Owner: ${project.owner?.name || project.namespace.name}`,
                        project: project
                    })),
                    {
                        placeHolder: 'Select a project to view details',
                        matchOnDescription: true,
                        matchOnDetail: true
                    }
                );

                if (selectedProject) {
                    // Show project details
                    const detailsMessage = [
                        `Name: ${selectedProject.project.name}`,
                        `Description: ${selectedProject.project.description || 'No description'}`,
                        `Visibility: ${selectedProject.project.visibility}`,
                        `URL: ${selectedProject.project.web_url}`,
                        `Last Activity: ${new Date(selectedProject.project.last_activity_at).toLocaleString()}`,
                        `Owner: ${selectedProject.project.owner?.name || selectedProject.project.namespace.name}`
                    ].join('\n');

                    const action = await vscode.window.showInformationMessage(
                        detailsMessage,
                        'Clone Repository'
                    );

                    if (action === 'Clone Repository') {
                        await vscode.commands.executeCommand('frontier.cloneRepository', selectedProject.project.http_url_to_repo);
                    }
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to list projects: ${error instanceof Error ? error.message : 'Unknown error'}`);
                return [];
            }
        })
    );

    // Register create and clone project command
    context.subscriptions.push(
        vscode.commands.registerCommand('frontier.createAndCloneProject', async () => {
            try {
                // Get project name
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter project name',
                    validateInput: (value) => {
                        if (!value) {
                            return 'Project name is required';
                        }
                        if (!/^[\w.-]+$/.test(value)) {
                            return 'Invalid project name';
                        }
                        return null;
                    }
                });
                if (!name) {
                    return;
                }

                // Get description (optional)
                const description = await vscode.window.showInputBox({
                    prompt: 'Enter project description (optional)',
                });

                // Get visibility
                const visibility = await vscode.window.showQuickPick(
                    ['private', 'internal', 'public'],
                    { placeHolder: 'Select project visibility' }
                ) as 'private' | 'internal' | 'public' | undefined;
                if (!visibility) {
                    return;
                }

                // Try to create as personal project first
                try {
                    await scmManager.createAndCloneProject({
                        name,
                        description,
                        visibility
                    });
                } catch (error) {
                    // If personal project creation fails, try with organization
                    if (error instanceof Error && !error.message.includes('authentication failed')) {
                        const orgs = await gitLabService.listOrganizations();
                        if (orgs.length > 0) {
                            const selectedOrg = await vscode.window.showQuickPick(
                                orgs.map(org => ({
                                    label: org.name,
                                    description: org.path,
                                    id: org.id.toString()
                                })),
                                {
                                    placeHolder: 'Select an organization',
                                }
                            );

                            if (selectedOrg) {
                                await scmManager.createAndCloneProject({
                                    name,
                                    description,
                                    visibility,
                                    organizationId: selectedOrg.id
                                });
                                return;
                            }
                        }
                    }
                    throw error;
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create project: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        })
    );

    // Register clone existing repository command
    context.subscriptions.push(
        vscode.commands.registerCommand('frontier.cloneRepository', async () => {
            try {
                const repoUrl = await vscode.window.showInputBox({
                    prompt: 'Enter GitLab repository URL',
                    validateInput: (value) => {
                        if (!value) {
                            return 'Repository URL is required';
                        }
                        if (!value.startsWith('http')) {
                            return 'Please enter an HTTPS URL';
                        }
                        return null;
                    }
                });

                if (repoUrl) {
                    await scmManager.cloneExistingRepository(repoUrl);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        })
    );
}
