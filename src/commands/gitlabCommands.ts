import * as vscode from 'vscode';
import { FrontierAuthProvider } from '../auth/AuthenticationProvider';
import { GitLabService } from '../gitlab/GitLabService';

export function registerGitLabCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider
) {
    const gitlabService = new GitLabService(authProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('frontier.createGitLabProject', async () => {
            try {
                await gitlabService.initialize();

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
                );
                if (!visibility) { return; }

                // Get organization (optional)
                const orgs = await gitlabService.listOrganizations();
                if (orgs.length > 0) {
                    const orgItems = [
                        { label: 'Personal Project', id: undefined },
                        ...orgs.map(org => ({ label: org.name, id: org.id }))
                    ];

                    const selectedOrg = await vscode.window.showQuickPick(
                        orgItems,
                        { placeHolder: 'Select organization (optional)' }
                    );

                    const project = await gitlabService.createProject({
                        name,
                        description,
                        visibility: visibility as 'private' | 'internal' | 'public',
                        organizationId: selectedOrg?.id,
                    });

                    vscode.window.showInformationMessage(
                        `Project created successfully! URL: ${project.url}`
                    );
                }
            } catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(`Failed to create project: ${error.message}`);
                }
            }
        })
    );
} 