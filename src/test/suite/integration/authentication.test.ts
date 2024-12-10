import * as assert from "assert";
import * as vscode from "vscode";
import { activateExtension, sleep, clearAuthenticationState } from "../../helpers/testHelper";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { FrontierAuthProvider } from "../../../auth/AuthenticationProvider";

suite("Authentication Integration Tests", () => {
    let mockProvider: vscode.Disposable;
    let authProvider: FrontierAuthProvider;

    suiteSetup(async () => {
        await clearAuthenticationState();
        mockProvider = await registerMockAuthProvider();
        const extension = vscode.extensions.getExtension("frontier-rnd.frontier-authentication")!;
        const exports = await extension.activate();
        authProvider = exports.authProvider as FrontierAuthProvider;
        if (!authProvider) {
            throw new Error("Frontier auth provider not found");
        }
    });

    test("login should work", async () => {
        // Track if login was called
        let loginCalled = false;
        const originalLogin = authProvider.login;
        authProvider.login = async (username: string, password: string) => {
            loginCalled = true;
            assert.strictEqual(username, "test");
            assert.strictEqual(password, "test");
            return originalLogin.call(authProvider, username, password);
        };

        await vscode.commands.executeCommand("frontier.login", "test", "test");
        assert.strictEqual(loginCalled, true);

        // Restore original method
        authProvider.login = originalLogin;
    });

    test("Should handle authentication status checks", async () => {
        const statusCommand = await vscode.commands.executeCommand("frontier.getAuthStatus");
        assert.ok(statusCommand !== undefined);
    });

    suiteTeardown(async () => {
        await clearAuthenticationState();
        if (mockProvider) {
            mockProvider.dispose();
        }
    });
});
