// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { FrontierAuthProvider } from './auth/AuthenticationProvider';
import { registerCommands } from './commands';
import { registerGitLabCommands } from './commands/gitlabCommands';
import { registerSCMCommands } from './commands/scmCommands';
import { initialState, StateManager } from './state';
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

	// Register commands
	registerCommands(context, authenticationProvider);
	registerGitLabCommands(context, authenticationProvider);
	registerSCMCommands(context, authenticationProvider);

	// Create and register status bar item immediately
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	context.subscriptions.push(statusBarItem);

	// Update status bar when state changes
	stateManager.onDidChangeState(() => {
		updateStatusBar(statusBarItem, stateManager.getAuthState());
	});

	// Initial status bar update and show
	updateStatusBar(statusBarItem, stateManager.getAuthState());
	statusBarItem.show();

	// Only show activation message if not already authenticated
	if (!authenticationProvider.isAuthenticated) {
		vscode.window.showInformationMessage('Frontier Authentication: Click the status bar icon to log in');
	}

	// Dispose existing providers if they exist
	if (authenticationProvider) {
		// Removed dispose call here
	}

	// Register status bar item
	// Removed redundant registration here

	return {
		// Export the authentication provider for other extensions
		authProvider: authenticationProvider,
		
		// Export convenience methods
		getAuthStatus: () => authenticationProvider.getAuthStatus(),
		onAuthStatusChanged: (callback: (status: { isAuthenticated: boolean; gitlabInfo?: any }) => void) => 
			authenticationProvider.onAuthStatusChanged(callback),
		
		// Export direct auth methods
		login: async (username: string, password: string) => 
			vscode.commands.executeCommand('frontier.login', username, password),
		register: async (username: string, email: string, password: string) => 
			vscode.commands.executeCommand('frontier.register', username, email, password),
		logout: async () => vscode.commands.executeCommand('frontier.logout')
	};
}

function updateStatusBar(
	statusBarItem: vscode.StatusBarItem,
	authState: AuthState
) {
	if (authState.isAuthenticated) {
		statusBarItem.text = '$(check) Frontier: Logged In';
		statusBarItem.tooltip = 'Click to log out';
		statusBarItem.command = 'frontier.logout';
	} else {
		statusBarItem.text = '$(sign-in) Frontier: Sign In';
		statusBarItem.tooltip = 'Click to log in';
		statusBarItem.command = 'frontier.login';
	}
	statusBarItem.show(); // Always show the status bar item
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (authenticationProvider !== undefined) {
		authenticationProvider.dispose();
	}
}
