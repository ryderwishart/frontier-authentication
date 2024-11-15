import * as vscode from 'vscode';
import { FrontierAuthProvider } from '../auth/AuthenticationProvider';
import { AuthWebviewProvider } from '../webviews/authWebviewProvider';

export function registerCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider,
) {
    context.subscriptions.push(

        // Register commands
        vscode.commands.registerCommand('frontier.login', () => {
            vscode.commands.executeCommand('codex.auth.focus');
        }),

        vscode.commands.registerCommand('frontier.logout', async () => {
            await authProvider.logout();
            vscode.window.showInformationMessage('Successfully logged out');
        })
    );
}