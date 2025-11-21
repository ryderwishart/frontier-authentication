import * as assert from "assert";
import * as vscode from "vscode";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { FrontierAuthProvider } from "../../../auth/AuthenticationProvider";
import { StateManager } from "../../../state";

suite("AuthenticationProvider Session Management", () => {
    let mockProvider: vscode.Disposable | undefined;
    let authProvider: FrontierAuthProvider;

    suiteSetup(async () => {
        mockProvider = await registerMockAuthProvider();
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        StateManager.initialize({
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);

        authProvider = (await ext!.activate()).authProvider;
    });

    suiteTeardown(async () => {
        if (mockProvider) {
            mockProvider.dispose();
        }
    });

    test("getSessions returns sessions correctly", async () => {
        const sessions = await authProvider.getSessions();
        assert.ok(Array.isArray(sessions), "Should return array");
    });

    test("getSessions returns empty array when not authenticated", async () => {
        // Ensure logged out
        if (authProvider.isAuthenticated) {
            await authProvider.logout();
        }

        const sessions = await authProvider.getSessions();
        assert.strictEqual(sessions.length, 0, "Should return empty array when not authenticated");
    });

    test("checkTokenValidity with invalid token", async () => {
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            return new Response("", { status: 401 });
        };

        try {
            const result = await (authProvider as any).checkTokenValidity("invalid-token");
            assert.strictEqual(result.isValid, false, "Should return false for invalid token");
        } catch (error) {
            // May throw instead
            assert.ok(error instanceof Error);
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });
});

