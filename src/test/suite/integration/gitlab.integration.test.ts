import * as assert from "assert";
import * as vscode from "vscode";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { GitLabService } from "../../../gitlab/GitLabService";

suite("Integration: GitLabService API Integration", () => {
    let mockProvider: vscode.Disposable | undefined;
    let gitLabService: GitLabService;

    suiteSetup(async () => {
        mockProvider = await registerMockAuthProvider();
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        const authProvider = (await ext!.activate()).authProvider;
        gitLabService = new GitLabService(authProvider);
        (gitLabService as any).gitlabToken = "token";
        (gitLabService as any).gitlabBaseUrl = "https://gitlab.com";
    });

    suiteTeardown(async () => {
        if (mockProvider) {
            mockProvider.dispose();
        }
    });

    test("listGroups returns empty array when no groups", async () => {
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            return new Response(JSON.stringify([]), { status: 200 });
        };

        try {
            const groups = await gitLabService.listGroups();
            assert.ok(Array.isArray(groups), "Should return array");
            assert.strictEqual(groups.length, 0, "Should return empty array");
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });

    test("getRepositoryFile handles 404 error", async () => {
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            return new Response("", { status: 404 });
        };

        try {
            await assert.rejects(
                async () => {
                    await gitLabService.getRepositoryFile("123", "nonexistent.txt", "main");
                },
                (error: Error) => {
                    return error.message.includes("File not found") || error.message.includes("404");
                },
                "Should throw error for missing file"
            );
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });
});

