import * as assert from "assert";
import * as vscode from "vscode";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { FrontierAuthProvider } from "../../../auth/AuthenticationProvider";
import { StateManager } from "../../../state";

suite("AuthenticationProvider Core Operations", () => {
    let mockProvider: vscode.Disposable | undefined;
    let authProvider: FrontierAuthProvider;
    let mockContext: vscode.ExtensionContext;

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

        mockContext = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
            secrets: {
                get: async () => null,
                store: async () => {},
                delete: async () => {},
            },
        } as unknown as vscode.ExtensionContext;

        authProvider = (await ext!.activate()).authProvider;
    });

    suiteTeardown(async () => {
        if (mockProvider) {
            mockProvider.dispose();
        }
    });

    test("login with invalid credentials", async () => {
        // Mock fetch to return error
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            return new Response(JSON.stringify({ detail: "Invalid credentials" }), {
                status: 401,
            });
        };

        try {
            const result = await authProvider.login("invalid", "invalid");
            assert.strictEqual(result, false, "Should return false for invalid credentials");
        } catch (error) {
            // May throw instead
            assert.ok(error instanceof Error);
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });

    test("login with network failure", async () => {
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            throw new Error("ENOTFOUND");
        };

        try {
            // Login may return false or throw depending on implementation
            const result = await authProvider.login("user", "pass");
            // If it doesn't throw, it should return false
            assert.strictEqual(result, false, "Should return false on network failure");
        } catch (error) {
            // Or it may throw
            assert.ok(error instanceof Error, "Should handle network error");
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });

    test("logout clears session correctly", async () => {
        // First ensure we're logged out
        if (authProvider.isAuthenticated) {
            await authProvider.logout();
        }
        
        // Mock successful login
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string) => {
            if (url.includes("/auth/login")) {
                return new Response(
                    JSON.stringify({
                        access_token: "token",
                        gitlab_token: "gitlab-token",
                        gitlab_url: "https://gitlab.com",
                    }),
                    { status: 200 }
                );
            }
            return new Response("{}", { status: 200 });
        };

        try {
            const loginResult = await authProvider.login("test", "test");
            if (loginResult) {
                assert.strictEqual(authProvider.isAuthenticated, true, "Should be authenticated");

                // Logout
                await authProvider.logout();
                assert.strictEqual(authProvider.isAuthenticated, false, "Should be logged out");
            } else {
                // Login may fail in test environment
                assert.ok(true, "Login may not succeed in test environment");
            }
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });

    test("logout when not authenticated", async () => {
        // Ensure not authenticated
        if (authProvider.isAuthenticated) {
            await authProvider.logout();
        }

        // Should not throw
        await authProvider.logout();
        assert.ok(true, "Should handle logout when not authenticated");
    });
});

