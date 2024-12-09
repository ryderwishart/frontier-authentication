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

export async function clearAuthenticationState() {
    try {
        const session = await vscode.authentication.getSession('frontier', [], { createIfNone: false });
        if (session) {
            // Use the built-in logout command instead of direct session removal
            await vscode.commands.executeCommand('frontier.logout');
        }
    } catch (error) {
        console.error('Error clearing authentication state:', error);
    }
} 