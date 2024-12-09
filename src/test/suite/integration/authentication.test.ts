import * as assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension, sleep, clearAuthenticationState } from '../../helpers/testHelper';
import { registerMockAuthProvider } from '../../helpers/mockAuthProvider';

suite('Authentication Integration Tests', () => {
    let mockProvider: vscode.Disposable;

    suiteSetup(async () => {
        await clearAuthenticationState();
        // Register our mock provider before tests
        mockProvider = registerMockAuthProvider();
    });

    test('Should handle authentication flow', async function() {
        this.timeout(5000); // Reduced timeout since we're not waiting for user input
        
        const { ext } = await activateExtension();
        
        // Test initial state
        const initialSession = await vscode.authentication.getSession('frontier', [], { createIfNone: false });
        assert.strictEqual(initialSession, undefined, 'Should start with no active session');

        // Simulate login by creating a session through the mock provider
        const session = await vscode.authentication.getSession('frontier', [], { createIfNone: true });
        assert.ok(session, 'Should have created a session');
        assert.strictEqual(session.account.label, 'Mock User');

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
        // Clean up our mock provider
        if (mockProvider) {
            mockProvider.dispose();
        }
    });
}); 