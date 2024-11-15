import * as vscode from 'vscode';
import { AuthenticationProvider } from './auth/AuthenticationProvider';
import { AuthWebviewProvider } from './webviews/authWebviewProvider';

export function registerCommands(
    context: vscode.ExtensionContext,
    authProvider: AuthenticationProvider,
    api_endpoint: string
) {
    // Register webview provider
    const authWebviewProvider = new AuthWebviewProvider(context.extensionUri, authProvider, api_endpoint);

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