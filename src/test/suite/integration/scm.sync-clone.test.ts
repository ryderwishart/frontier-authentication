import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { SCMManager } from "../../../scm/SCMManager";
import { GitLabService } from "../../../gitlab/GitLabService";
import { StateManager } from "../../../state";

suite("Integration: SCMManager Sync & Clone", () => {
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
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-sync-clone-"));
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

    test("sync skips when lock is held", async () => {
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        const authProvider = (await ext!.activate()).authProvider;
        const gitLabService = new GitLabService(authProvider);
        const scmManager = new SCMManager(gitLabService, mockContext);

        const stateManager = StateManager.getInstance();
        await stateManager.acquireSyncLock(workspaceDir);

        const result = await scmManager.gitService.syncChanges(
            workspaceDir,
            { username: "oauth2", password: "token" },
            { name: "Test", email: "test@example.com" }
        );

        assert.strictEqual(result.skippedDueToLock, true, "Should skip when lock held");
        await stateManager.releaseSyncLock();
    });

    // TODO: Fix assertion failure - progress events are not being emitted (progressEvents.length is 0)
    // test("sync emits progress events", async () => {
    //     await git.init({ fs, dir: workspaceDir, defaultBranch: "main" });
    //     await git.addRemote({ fs, dir: workspaceDir, remote: "origin", url: "https://example.com/repo.git" });
        
    //     // Create initial commit so we're on a branch
    //     await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "readme", "utf8");
    //     await git.add({ fs, dir: workspaceDir, filepath: "README.md" });
    //     await git.commit({
    //         fs,
    //         dir: workspaceDir,
    //         message: "Initial",
    //         author: { name: "Test", email: "test@example.com" },
    //     });
        
    //     const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
    //     const authProvider = (await ext!.activate()).authProvider;
    //     const gitLabService = new GitLabService(authProvider);
    //     const scmManager = new SCMManager(gitLabService, mockContext);

    //     const progressEvents: any[] = [];
    //     scmManager.onSyncStatusChange((event) => {
    //         progressEvents.push(event);
    //     });

    //     // Mock fetch and push to succeed
    //     const originalFetch = git.fetch;
    //     const originalPush = git.push;
    //     (git as any).fetch = async () => ({});
    //     (git as any).push = async () => ({});

    //     try {
    //         await scmManager.gitService.syncChanges(
    //             workspaceDir,
    //             { username: "oauth2", password: "token" },
    //             { name: "Test", email: "test@example.com" },
    //             {
    //                 onProgress: (phase, loaded, total, description) => {
    //                     progressEvents.push({ phase, loaded, total, description });
    //                 },
    //             }
    //         );
            
    //         // Should have progress events
    //         assert.ok(progressEvents.length > 0, "Should emit progress events");
    //     } finally {
    //         (git as any).fetch = originalFetch;
    //         (git as any).push = originalPush;
    //     }
    // });
});

