import * as vscode from 'vscode';
import * as assert from 'assert';

export async function activateExtension() {
    const ext = vscode.extensions.getExtension('frontier-rnd.frontier-authentication');
    if (!ext) {
        throw new Error('Extension not found');
    }
    const api = await ext.activate();
    return { ext, api };
}

export async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function assertCommandExists(commandId: string) {
    const commands = vscode.commands.getCommands();
    assert.ok(commands.then(cmds => cmds.includes(commandId)), `Command ${commandId} should exist`);
}

export async function isProviderRegistered(providerId: string): Promise<boolean> {
    try {
        await vscode.authentication.getSession(providerId, [], { createIfNone: false });
        return true;
    } catch (error) {
        if (error instanceof Error && error.message.includes('No authentication provider')) {
            return false;
        }
        throw error;
    }
}

export async function clearAuthenticationState() {
    try {
        // Get the current session
        const session = await vscode.authentication.getSession('frontier', [], { createIfNone: false });
        if (session) {
            // Use the extension's API to force logout without dialog
            await vscode.commands.executeCommand('frontier.forceLogout');
        }
    } catch (error: unknown) {
        // Ignore dialog-related errors in test environment
        if (error instanceof Error && !error.message.includes('DialogService')) {
            console.error('Error clearing authentication state:', error);
        }
    }
} 