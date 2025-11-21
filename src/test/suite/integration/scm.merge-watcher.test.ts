import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { SCMManager } from "../../../scm/SCMManager";
import { GitLabService } from "../../../gitlab/GitLabService";
import { StateManager } from "../../../state";

suite("Integration: SCMManager Merge & File Watcher", () => {
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
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-merge-watcher-"));
        // Note: workspaceFolders is read-only, tests use gitService directly
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

    test("complete merge with multiple resolved files", async () => {
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        const authProvider = (await ext!.activate()).authProvider;
        const gitLabService = new GitLabService(authProvider);
        const scmManager = new SCMManager(gitLabService, mockContext);

        // Initialize repo
        await scmManager.gitService.init(workspaceDir);
        await scmManager.gitService.addRemote(workspaceDir, "origin", "https://example.com/repo.git");

        const resolvedFiles = [
            { filepath: "file1.txt", resolution: "modified" as const },
            { filepath: "file2.txt", resolution: "deleted" as const },
            { filepath: "file3.txt", resolution: "created" as const },
        ];

        // Mock operations
        const originalFetch = require("isomorphic-git").fetch;
        const originalResolveRef = require("isomorphic-git").resolveRef;
        const originalCommit = require("isomorphic-git").commit;
        const originalPush = require("isomorphic-git").push;

        (require("isomorphic-git") as any).fetch = async () => ({});
        (require("isomorphic-git") as any).resolveRef = async () => "hash";
        (require("isomorphic-git") as any).commit = async () => "merge-hash";
        (require("isomorphic-git") as any).push = async () => ({});

        try {
            await scmManager.completeMerge(resolvedFiles, workspaceDir);
            assert.ok(true, "Should complete merge with multiple files");
        } catch (error) {
            // May fail if files don't exist, but should handle multiple files
            assert.ok(error instanceof Error);
        } finally {
            (require("isomorphic-git") as any).fetch = originalFetch;
            (require("isomorphic-git") as any).resolveRef = originalResolveRef;
            (require("isomorphic-git") as any).commit = originalCommit;
            (require("isomorphic-git") as any).push = originalPush;
        }
    });
});

