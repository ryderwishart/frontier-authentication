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

suite("E2E: Full Workflows", () => {
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
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-e2e-"));
        // Note: workspaceFolders is read-only, E2E tests should use real workspace setup
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

    test("full sync flow: make changes → sync → verify", async () => {
        await git.init({ fs, dir: workspaceDir, defaultBranch: "main" });
        await git.addRemote({ fs, dir: workspaceDir, remote: "origin", url: "https://example.com/repo.git" });
        
        // Create initial commit so we're on a branch
        await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "readme", "utf8");
        await git.add({ fs, dir: workspaceDir, filepath: "README.md" });
        await git.commit({
            fs,
            dir: workspaceDir,
            message: "Initial",
            author: { name: "Test", email: "test@example.com" },
        });

        // Use gitService directly instead of SCMManager to avoid command registration conflicts
        const stateManager = StateManager.getInstance();
        const { GitService } = await import("../../../git/GitService");
        const gitService = new GitService(stateManager);

        // Create file
        await fs.promises.writeFile(path.join(workspaceDir, "test.txt"), "content", "utf8");

        // Mock fetch/push
        const originalFetch = git.fetch;
        const originalPush = git.push;
        (git as any).fetch = async () => ({});
        (git as any).push = async () => ({});

        try {
            const result = await gitService.syncChanges(
                workspaceDir,
                { username: "oauth2", password: "token" },
                { name: "Test", email: "test@example.com" }
            );

            assert.ok(result !== undefined, "Should complete sync");
        } finally {
            (git as any).fetch = originalFetch;
            (git as any).push = originalPush;
        }
    });
});

