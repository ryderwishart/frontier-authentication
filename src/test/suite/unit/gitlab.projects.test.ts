import * as assert from "assert";
import * as vscode from "vscode";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { GitLabService } from "../../../gitlab/GitLabService";

suite("GitLabService Project Operations", () => {
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

    test("createProject handles API errors", async () => {
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            return new Response(JSON.stringify({ message: "Project already exists" }), {
                status: 400,
            });
        };

        try {
            await assert.rejects(
                async () => {
                    await gitLabService.createProject({ name: "test", visibility: "private" });
                },
                (error: Error) => {
                    return error.message.includes("Failed") || error.message.includes("400");
                }
            );
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });

    test("getProject returns null when project not found", async () => {
        const originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async () => {
            return new Response(JSON.stringify([]), { status: 200 });
        };

        try {
            const result = await gitLabService.getProject("nonexistent");
            assert.strictEqual(result, null, "Should return null when not found");
        } finally {
            (globalThis as any).fetch = originalFetch;
        }
    });
});

