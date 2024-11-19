import * as vscode from 'vscode';
import { SCMManager } from '../scm/SCMManager';
import { GitLabService } from '../gitlab/GitLabService';
import { FrontierAuthProvider } from '../auth/AuthenticationProvider';

export function registerSCMCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider
) {
    const gitlabService = new GitLabService(authProvider);
    const scmManager = new SCMManager(gitlabService, context);

    // Command to create and clone a new project
    context.subscriptions.push(
        vscode.commands.registerCommand('frontier.createAndCloneProject', async () => {
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
                if (!name) { return; }

                // Get description (optional)
                const description = await vscode.window.showInputBox({
                    prompt: 'Enter project description (optional)',
                });

                // Get visibility
                const visibility = await vscode.window.showQuickPick(
                    ['private', 'internal', 'public'],
                    { placeHolder: 'Select project visibility' }
                ) as 'private' | 'internal' | 'public' | undefined;
                if (!visibility) { return; }

                await scmManager.createAndCloneProject({
                    name,
                    description,
                    visibility
                });
            } catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(
                        `Failed to create and clone project: ${error.message}`
                    );
                }
            }
        })
    );

    // Command to clone an existing repository
    context.subscriptions.push(
        vscode.commands.registerCommand('frontier.cloneRepository', async () => {
            try {
                const repoUrl = await vscode.window.showInputBox({
                    prompt: 'Enter repository URL',
                    validateInput: (value) => {
                        if (!value) {
                            return 'Repository URL is required';
                        }
                        if (!value.endsWith('.git')) {
                            return 'Invalid repository URL. Must end with .git';
                        }
                        return null;
                    }
                });
                if (!repoUrl) { return; }

                await scmManager.cloneExistingRepository(repoUrl);
            } catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(
                        `Failed to clone repository: ${error.message}`
                    );
                }
            }
        })
    );
}
