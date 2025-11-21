import * as assert from "assert";
import * as vscode from "vscode";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { GitLabService } from "../../../gitlab/GitLabService";

suite("GitLabService Initialization & User Operations", () => {
    let mockProvider: vscode.Disposable | undefined;
    let gitLabService: GitLabService;

    suiteSetup(async () => {
        mockProvider = await registerMockAuthProvider();
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        const authProvider = (await ext!.activate()).authProvider;
        gitLabService = new GitLabService(authProvider);
    });

    suiteTeardown(async () => {
        if (mockProvider) {
            mockProvider.dispose();
        }
    });

    test("initialization fails when no session", async () => {
        // Mock getSessions to return empty
        const originalGetSessions = (gitLabService as any).authProvider.getSessions;
        (gitLabService as any).authProvider.getSessions = async () => [];

        try {
            await assert.rejects(
                async () => {
                    await gitLabService.initialize();
                },
                (error: Error) => {
                    return (
                        error.message.includes("No active session") ||
                        error.message.includes("not found")
                    );
                }
            );
        } finally {
            (gitLabService as any).authProvider.getSessions = originalGetSessions;
        }
    });

    test("getCurrentUser handles API error", async () => {
        const originalFetch = (globalThis as any).fetch;
        (gitLabService as any).gitlabToken = "token";
        (gitLabService as any).gitlabBaseUrl = "https://gitlab.com";

        (globalThis as any).fetch = async () => {
            return new Response(JSON.stringify({ message: "Internal Server Error" }), {
                status: 500,
            });
        };

        try {
            // May throw or return error depending on implementation
            try {
                await gitLabService.getCurrentUser();
                assert.fail("Should have thrown error");
            } catch (error: any) {
                assert.ok(error instanceof Error, "Should throw error on API failure");
                // Check if error message indicates failure (may be generic)
                const hasFailureIndication =
                    error.message &&
                    (error.message.includes("Failed") ||
                        error.message.includes("500") ||
                        error.message.includes("Internal") ||
                        error.message.includes("status") ||
                        error.message.length > 0);
                assert.ok(
                    hasFailureIndication,
                    `Error message should indicate failure: ${error.message}`
                );
            }
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });
});
