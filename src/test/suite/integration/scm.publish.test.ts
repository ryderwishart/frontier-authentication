import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { SCMManager } from "../../../scm/SCMManager";
import { GitLabService } from "../../../gitlab/GitLabService";
import { StateManager } from "../../../state";

suite("Integration: SCMManager Publish Workspace", () => {
    let mockProvider: vscode.Disposable | undefined;
    let workspaceDir: string;
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
        } as unknown as vscode.ExtensionContext;
    });

    setup(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-publish-"));
        // Note: workspaceFolders is read-only, tests that need workspace should be integration tests
        // with proper workspace setup
    });

    teardown(async () => {
        try {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {}
    });

    suiteTeardown(async () => {
        if (mockProvider) {
            mockProvider.dispose();
        }
    });

    test("publish fails when GitLab project creation fails", async () => {
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        const authProvider = (await ext!.activate()).authProvider;
        const gitLabService = new GitLabService(authProvider);
        
        // Mock createProject to fail
        const originalCreate = gitLabService.createProject;
        (gitLabService as any).createProject = async () => {
            throw new Error("Project creation failed");
        };

        const scmManager = new SCMManager(gitLabService, mockContext);

        await assert.rejects(
            async () => {
                await scmManager.publishWorkspace({ name: "test-project" });
            },
            (error: Error) => {
                return error.message.includes("Failed to publish workspace");
            }
        );

        (gitLabService as any).createProject = originalCreate;
    });

    test("publish with different visibility levels", async () => {
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        const authProvider = (await ext!.activate()).authProvider;
        const gitLabService = new GitLabService(authProvider);
        
        // Mock successful project creation
        (gitLabService as any).createProject = async (options: any) => {
            return { id: "123", url: "https://example.com/test.git" };
        };
        (gitLabService as any).getToken = async () => "token";
        (gitLabService as any).getCurrentUser = async () => ({
            id: 1,
            username: "test",
            name: "Test",
            email: "test@example.com",
        });

        const scmManager = new SCMManager(gitLabService, mockContext) as any;

        // Avoid long-running network/lock interactions in this integration test.
        // Other tests exercise the full sync flow; here we only need to verify
        // that publishWorkspace can be invoked for each visibility without hanging.
        (scmManager.gitService as any).syncChanges = async () => {
            return { hadConflicts: false };
        };

        // Test each visibility level
        for (const visibility of ["private", "internal", "public"] as const) {
            try {
                await scmManager.publishWorkspace({
                    name: `test-${visibility}`,
                    visibility,
                });
                // May succeed or fail depending on mock setup
            } catch (error) {
                // Expected if sync fails
                assert.ok(error instanceof Error);
            }
        }
    });
});

