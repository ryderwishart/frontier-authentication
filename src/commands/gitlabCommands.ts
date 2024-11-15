import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { FrontierAuthProvider } from '../auth/AuthenticationProvider';

interface CreateProjectOptions {
    name: string;
    description?: string;
    visibility?: 'private' | 'internal' | 'public';
}

export async function registerGitLabCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider
) {
    const createProjectCommand = vscode.commands.registerCommand(
        'frontier.createGitLabProject',
        async () => {
            try {
                // Check authentication
                if (!authProvider.isAuthenticated) {
                    throw new Error('Please login first');
                }

                // Get project name from user
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter project name',
                    placeHolder: 'my-awesome-project',
                    validateInput: (value) => {
                        return value && value.length > 0 ? null : 'Project name is required';
                    }
                });

                if (!name) {
                    return; // User cancelled
                }

                // Get project description (optional)
                const description = await vscode.window.showInputBox({
                    prompt: 'Enter project description (optional)',
                    placeHolder: 'Description of my awesome project'
                });

                // Get visibility
                const visibility = await vscode.window.showQuickPick(
                    ['private', 'internal', 'public'],
                    {
                        placeHolder: 'Select project visibility',
                        title: 'Project Visibility'
                    }
                ) as CreateProjectOptions['visibility'];

                if (!visibility) {
                    return; // User cancelled
                }

                const token = await authProvider.getToken();
                if (!token) {
                    throw new Error('Authentication token not found');
                }

                // Create the project
                const response = await fetch('https://git.frontierrnd.com/api/v4/projects', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify({
                        name,
                        description,
                        visibility,
                        initialize_with_readme: true
                    })
                });

                if (!response.ok) {
                    const error = await response.text();
                    throw new Error(`Failed to create project: ${error}`);
                }

                const project = await response.json();

                // Show success message with clone URL
                const cloneUrl = project.ssh_url_to_repo;
                const action = await vscode.window.showInformationMessage(
                    `Project "${name}" created successfully!`,
                    'Copy Clone URL',
                    'Open in Browser'
                );

                if (action === 'Copy Clone URL') {
                    await vscode.env.clipboard.writeText(cloneUrl);
                    vscode.window.showInformationMessage('Clone URL copied to clipboard!');
                } else if (action === 'Open in Browser') {
                    vscode.env.openExternal(vscode.Uri.parse(project.web_url));
                }

            } catch (error) {
                vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Failed to create project');
            }
        }
    );

    context.subscriptions.push(createProjectCommand);
} 