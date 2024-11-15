import * as vscode from 'vscode';
import { AuthenticationProvider } from './auth/AuthenticationProvider';
import { LoginWebviewProvider } from './webviews/loginWebviewProvider';
import { RegisterWebviewProvider } from './webviews/registerWebviewProvider';

export function registerCommands(
    context: vscode.ExtensionContext,
    authProvider: AuthenticationProvider,
    api_endpoint: string
) {
    // Register webview providers
    const loginProvider = new LoginWebviewProvider(context.extensionUri, authProvider, api_endpoint);
    const registerProvider = new RegisterWebviewProvider(context.extensionUri, authProvider, api_endpoint);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('frontier.loginView', loginProvider),
        vscode.window.registerWebviewViewProvider('frontier.registerView', registerProvider),

        // Register commands
        vscode.commands.registerCommand('frontier.login', () => {
            vscode.commands.executeCommand('frontier.loginView.focus');
        }),

        vscode.commands.registerCommand('frontier.register', () => {
            vscode.commands.executeCommand('frontier.registerView.focus');
        }),

        vscode.commands.registerCommand('frontier.logout', async () => {
            await authProvider.logout();
            vscode.window.showInformationMessage('Successfully logged out');
        })
    );
}