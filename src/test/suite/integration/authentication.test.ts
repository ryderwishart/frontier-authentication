import * as assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension, sleep, clearAuthenticationState } from '../../helpers/testHelper';

suite('Authentication Integration Tests', () => {
    suiteSetup(async () => {
        await clearAuthenticationState();
    });

    test('Should handle authentication flow', async function() {
        this.timeout(10000); // Authentication might take some time
        
        const { ext } = await activateExtension();
        
        // Test initial state
        const initialSession = await vscode.authentication.getSession('frontier', [], { createIfNone: false });
        assert.strictEqual(initialSession, undefined, 'Should start with no active session');

        // Trigger login command (this will open browser, so we can't fully automate it)
        // But we can test the command exists and executes
        const loginCommand = await vscode.commands.executeCommand('frontier.login');
        assert.ok(loginCommand !== undefined);

        // Test logout functionality
        await vscode.commands.executeCommand('frontier.logout');
        const finalSession = await vscode.authentication.getSession('frontier', [], { createIfNone: false });
        assert.strictEqual(finalSession, undefined, 'Should have no session after logout');
    });

    test('Should handle authentication status checks', async () => {
        const statusCommand = await vscode.commands.executeCommand('frontier.getAuthStatus');
        assert.ok(statusCommand !== undefined);
    });

    suiteTeardown(async () => {
        await clearAuthenticationState();
    });
}); 