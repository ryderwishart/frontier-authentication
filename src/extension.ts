// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { FrontierAuthProvider } from './auth/AuthenticationProvider';
import { registerCommands } from './commands';
import { AuthWebviewProvider } from './webviews/authWebviewProvider';
import { registerGitLabCommands } from './commands/gitlabCommands';
import { StateManager } from './state';
import { AuthState } from './types/state';

let authenticationProvider: FrontierAuthProvider;

const API_ENDPOINT = 'https://api.frontierrnd.com/api/v1';
// const API_ENDPOINT = 'http://localhost:8000/api/v1';

// FIXME: let's gracefully handle offline (block login, for instance)
// TODO: let's display status for the user - cloud sync available, AI online, etc.
// TODO: if the user wants to use an offline LLM, we should check the heartbeat, etc.

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	// Initialize state manager first
	const stateManager = StateManager.initialize(context);

	// Initialize auth provider with state manager
	authenticationProvider = new FrontierAuthProvider(context, API_ENDPOINT);
	await authenticationProvider.initialize();

	// Only show activation message if not already authenticated
	if (!authenticationProvider.isAuthenticated) {
		vscode.window.showInformationMessage('Activating Frontier Authentication extension');
	}

	// Dispose existing providers if they exist
	if (authenticationProvider) {
		authenticationProvider.dispose();
	}

	// Create new providers
	const authViewProvider = new AuthWebviewProvider(
		context.extensionUri, 
		authenticationProvider, 
		API_ENDPOINT
	);

	// Register webview providers
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('codex.auth', authViewProvider, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		})
	);

	// Register commands
	registerCommands(context, authenticationProvider);
	registerGitLabCommands(context, authenticationProvider);

	// Register status bar item
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right
	);
	context.subscriptions.push(statusBarItem);

	// Update status bar when state changes
	stateManager.onDidChangeState(() => {
		updateStatusBar(statusBarItem, stateManager.getAuthState());
	});

	// Initial status bar update
	updateStatusBar(statusBarItem, stateManager.getAuthState());

	// Add new command for confirming logout
	context.subscriptions.push(
		vscode.commands.registerCommand('frontier.confirmLogout', async () => {
			const choice = await vscode.window.showWarningMessage(
				'Are you sure you want to log out?',
				{ modal: true },
				'Log Out',
				'Cancel'
			);

			if (choice === 'Log Out') {
				await authenticationProvider.logout();
				vscode.window.showInformationMessage('Successfully logged out');
			}
		})
	);
}

function updateStatusBar(
	statusBarItem: vscode.StatusBarItem,
	authState: AuthState
) {
	if (authState.isAuthenticated) {
		statusBarItem.text = "$(check) Authenticated";
		statusBarItem.command = 'frontier.confirmLogout';
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
