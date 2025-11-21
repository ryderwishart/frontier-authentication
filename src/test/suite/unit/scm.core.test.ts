import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerMockAuthProvider } from "../../helpers/mockAuthProvider";
import { SCMManager } from "../../../scm/SCMManager";
import { GitLabService } from "../../../gitlab/GitLabService";
import { StateManager } from "../../../state";

suite("SCMManager Core Operations", () => {
    let mockProvider: vscode.Disposable | undefined;
    let scmManager: SCMManager;
    let workspaceDir: string;
    let mockContext: vscode.ExtensionContext;

    suiteSetup(async () => {
        mockProvider = await registerMockAuthProvider();
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        StateManager.initialize({
            globalState: {
                get: () => undefined,
                update: async () => {},
            },
            workspaceState: {
                get: () => undefined,
                update: async () => {},
            },
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);

        mockContext = {
            subscriptions: [],
            globalState: {
                get: () => undefined,
                update: async () => {},
            },
            workspaceState: {
                get: () => undefined,
                update: async () => {},
            },
        } as unknown as vscode.ExtensionContext;
    });

    setup(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-scm-core-"));
        
        // Note: workspaceFolders is read-only, so we can't mock it directly
        // Instead, tests that need workspace should use a real workspace setup
        // For these unit tests, we'll test the methods that don't require workspace
        
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        const authProvider = (await ext!.activate()).authProvider;
        const gitLabService = new GitLabService(authProvider);
        scmManager = new SCMManager(gitLabService, mockContext);
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

    test("toggleAutoSync enables auto-sync when disabled", async () => {
        assert.strictEqual(scmManager.isAutoSyncEnabled(), false, "Should start disabled");
        
        // Access private method via type assertion for testing
        (scmManager as any).toggleAutoSync();
        
        assert.strictEqual(scmManager.isAutoSyncEnabled(), true, "Should be enabled after toggle");
    });

    test("toggleAutoSync disables auto-sync when enabled", async () => {
        // Enable first
        (scmManager as any).toggleAutoSync();
        assert.strictEqual(scmManager.isAutoSyncEnabled(), true, "Should be enabled");
        
        // Disable
        (scmManager as any).toggleAutoSync();
        assert.strictEqual(scmManager.isAutoSyncEnabled(), false, "Should be disabled after toggle");
    });

    test("auto-sync respects sync lock", async () => {
        // Initialize git repo first
        await scmManager.gitService.init(workspaceDir);
        
        const stateManager = StateManager.getInstance();
        
        // Acquire lock
        await stateManager.acquireSyncLock(workspaceDir);
        assert.strictEqual(stateManager.isSyncLocked(), true, "Lock should be held");
        
        // Auto-sync should skip when lock is held
        // This is tested through syncChanges behavior
        const result = await scmManager.gitService.syncChanges(
            workspaceDir,
            { username: "oauth2", password: "token" },
            { name: "Test", email: "test@example.com" }
        );
        
        assert.strictEqual(result.skippedDueToLock, true, "Should skip when lock held");
        
        await stateManager.releaseSyncLock();
    });
});

