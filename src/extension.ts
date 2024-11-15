// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { FrontierAuthProvider } from './auth/AuthenticationProvider';
import { registerCommands } from './commands';
import { AuthWebviewProvider } from './webviews/authWebviewProvider';

let authenticationProvider: FrontierAuthProvider;

// FIXME: let's gracefully handle offline (block login, for instance)
// TODO: let's display status for the user - cloud sync available, AI online, etc.
// TODO: if the user wants to use an offline LLM, we should check the heartbeat, etc.

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	vscode.window.showInformationMessage('Activating Frontier Authentication extension');
	// Initialize auth provider
	authenticationProvider = new FrontierAuthProvider(context);

	const API_ENDPOINT = 'https://api.frontierrnd.com/api/v1';
	// const API_ENDPOINT = 'http://localhost:8000/api/v1';

	// Dispose existing providers if they exist
	if (authenticationProvider) {
		authenticationProvider.dispose();
	}

	// Create new providers
	const authViewProvider = new AuthWebviewProvider(context.extensionUri, authenticationProvider, API_ENDPOINT);

	// Register webview providers
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('codex.auth', authViewProvider)
	);

	// Register commands
	registerCommands(context, authenticationProvider, API_ENDPOINT);

	// Register status bar item
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right
	);
	context.subscriptions.push(statusBarItem);

	if (authenticationProvider !== undefined) {
		// Update status bar based on auth state
		authenticationProvider.onDidChangeAuthentication(() => {
			updateStatusBar(statusBarItem, authenticationProvider);
		});
	}

	// Initial status bar update
	updateStatusBar(statusBarItem, authenticationProvider);
}

function updateStatusBar(
	statusBarItem: vscode.StatusBarItem,
	authProvider: FrontierAuthProvider
) {
	if (authProvider.isAuthenticated) {
		statusBarItem.text = "$(check) Authenticated";
		statusBarItem.command = 'frontier.logout';
	} else {
		statusBarItem.text = "$(key) Login";
		statusBarItem.command = 'frontier.login';
	}
	statusBarItem.show();
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (authenticationProvider !== undefined) {
		authenticationProvider.dispose();
	}
}
