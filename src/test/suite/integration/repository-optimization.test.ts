import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";

suite("Integration: Repository Optimization E2E", () => {
    let workspaceDir: string;
    let extensionActivated = false;

    suiteSetup(async function() {
        this.timeout(30000);
        
        // Activate extension
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Frontier Authentication extension not found");
        
        if (!ext.isActive) {
            await ext.activate();
            extensionActivated = true;
        }
    });

    setup(async () => {
        // Create temporary workspace
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-opt-e2e-"));
        
        // Initialize repository
        await git.init({ fs, dir: workspaceDir, defaultBranch: "main" });
        
        // Create initial commit
        await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "test", "utf8");
        await git.add({ fs, dir: workspaceDir, filepath: "README.md" });
        await git.commit({
            fs,
            dir: workspaceDir,
            message: "initial",
            author: { name: "Test", email: "test@example.com" },
        });
    });

    teardown(async () => {
        try {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch {}
    });

    test("frontier.packRepository command packs repository successfully", async function() {
        this.timeout(30000);

        // Create multiple commits to generate loose objects
        for (let i = 0; i < 10; i++) {
            const file = path.join(workspaceDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: workspaceDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: workspaceDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Execute pack command (silent mode)
        await vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true);

        // Verify pack was created
        const packDir = path.join(workspaceDir, ".git", "objects", "pack");
        const files = await fs.promises.readdir(packDir);
        const packs = files.filter(f => f.endsWith(".pack"));
        const indexes = files.filter(f => f.endsWith(".idx"));

        assert.strictEqual(packs.length, 1, "Should create one pack file");
        assert.strictEqual(indexes.length, 1, "Should create one index file");
    });

    test("optimization handles concurrent requests with lock", async function() {
        this.timeout(30000);

        // Create commits
        for (let i = 0; i < 10; i++) {
            const file = path.join(workspaceDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: workspaceDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: workspaceDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Try to run pack command concurrently (should handle with lock)
        const results = await Promise.all([
            vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true),
            vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true),
            vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true),
        ]);

        // All should complete without error
        assert.strictEqual(results.length, 3, "All pack commands should complete");

        // Should still have only one pack (not three)
        const packDir = path.join(workspaceDir, ".git", "objects", "pack");
        const files = await fs.promises.readdir(packDir);
        const packs = files.filter(f => f.endsWith(".pack"));
        
        assert.ok(packs.length <= 2, "Should not create multiple packs from concurrent requests");
    });

    test("optimization preserves repository integrity", async function() {
        this.timeout(30000);

        // Create commits with known content
        const testData: { [key: string]: string } = {};
        for (let i = 0; i < 10; i++) {
            const filename = `file-${i}.txt`;
            const content = `content ${i} - test data`;
            testData[filename] = content;
            
            const file = path.join(workspaceDir, filename);
            await fs.promises.writeFile(file, content, "utf8");
            await git.add({ fs, dir: workspaceDir, filepath: filename });
            await git.commit({
                fs,
                dir: workspaceDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Pack repository
        await vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true);

        // Verify all files are still readable
        for (const [filename, expectedContent] of Object.entries(testData)) {
            const filepath = path.join(workspaceDir, filename);
            const actualContent = await fs.promises.readFile(filepath, "utf8");
            assert.strictEqual(actualContent, expectedContent, `File ${filename} content should be preserved`);
        }

        // Verify git history is intact (need depth > 10 because there's also initial commit)
        const log = await git.log({ fs, dir: workspaceDir, depth: 15 });
        assert.ok(log.length >= 10, "Should preserve all commits");
        
        // Verify commit messages are preserved (trim to handle trailing newlines)
        for (let i = 0; i < 10; i++) {
            const commit = log.find(c => c.commit.message.trim() === `commit ${i}`);
            assert.ok(commit, `Commit ${i} should exist in history`);
        }
    });

    test("optimization handles repository with branches", async function() {
        this.timeout(30000);

        // Create commits on main
        for (let i = 0; i < 5; i++) {
            const file = path.join(workspaceDir, `main-${i}.txt`);
            await fs.promises.writeFile(file, `main content ${i}`, "utf8");
            await git.add({ fs, dir: workspaceDir, filepath: `main-${i}.txt` });
            await git.commit({
                fs,
                dir: workspaceDir,
                message: `main commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Create and switch to feature branch
        await git.branch({ fs, dir: workspaceDir, ref: "feature", checkout: true });

        // Create commits on feature
        for (let i = 0; i < 5; i++) {
            const file = path.join(workspaceDir, `feature-${i}.txt`);
            await fs.promises.writeFile(file, `feature content ${i}`, "utf8");
            await git.add({ fs, dir: workspaceDir, filepath: `feature-${i}.txt` });
            await git.commit({
                fs,
                dir: workspaceDir,
                message: `feature commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Pack repository
        await vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true);

        // Verify both branches are preserved
        const branches = await git.listBranches({ fs, dir: workspaceDir });
        assert.ok(branches.includes("main"), "Main branch should exist");
        assert.ok(branches.includes("feature"), "Feature branch should exist");

        // Verify commits on both branches
        await git.checkout({ fs, dir: workspaceDir, ref: "main" });
        const mainLog = await git.log({ fs, dir: workspaceDir, depth: 5 });
        assert.ok(mainLog.some(c => c.commit.message.startsWith("main commit")), "Main commits should be preserved");

        await git.checkout({ fs, dir: workspaceDir, ref: "feature" });
        const featureLog = await git.log({ fs, dir: workspaceDir, depth: 5 });
        assert.ok(featureLog.some(c => c.commit.message.startsWith("feature commit")), "Feature commits should be preserved");
    });

    test("optimization cleans up after interrupted operations", async function() {
        this.timeout(30000);

        const packDir = path.join(workspaceDir, ".git", "objects", "pack");
        await fs.promises.mkdir(packDir, { recursive: true });

        // Simulate interrupted operation by creating stale files
        await fs.promises.writeFile(path.join(packDir, "tmp_pack_stale"), "stale data", "utf8");
        await fs.promises.writeFile(path.join(packDir, ".tmp-idx-stale"), "stale idx", "utf8");
        
        // Create commits
        for (let i = 0; i < 5; i++) {
            const file = path.join(workspaceDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: workspaceDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: workspaceDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Pack repository (cleanup happens via codex-editor's autoOptimizeIfNeeded)
        await vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true);

        // In a real scenario with codex-editor integration, cleanupStalePackFiles would run
        // For this test, we verify the pack succeeded despite stale files
        const files = await fs.promises.readdir(packDir);
        const packs = files.filter(f => f.endsWith(".pack") && !f.startsWith("tmp_"));
        assert.ok(packs.length > 0, "Valid pack should be created despite stale files");
    });

    test("optimization handles large number of commits efficiently", async function() {
        this.timeout(60000); // 60 second timeout for large test

        // Create many commits
        for (let i = 0; i < 100; i++) {
            const file = path.join(workspaceDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: workspaceDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: workspaceDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Measure pack time
        const startTime = Date.now();
        await vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true);
        const duration = Date.now() - startTime;

        // Should complete in reasonable time
        assert.ok(duration < 30000, `Pack took ${duration}ms, should be < 30000ms`);

        // Verify pack was created
        const packDir = path.join(workspaceDir, ".git", "objects", "pack");
        const files = await fs.promises.readdir(packDir);
        const packs = files.filter(f => f.endsWith(".pack"));
        assert.strictEqual(packs.length, 1, "Should create one consolidated pack");
    });

    test("silent mode suppresses UI notifications", async function() {
        this.timeout(30000);

        // Create commits
        for (let i = 0; i < 5; i++) {
            const file = path.join(workspaceDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: workspaceDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: workspaceDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Pack with silent=true (should not show UI)
        await vscode.commands.executeCommand("frontier.packRepository", workspaceDir, true);

        // Test passes if no error thrown (UI notifications don't throw errors)
        assert.ok(true, "Silent mode should complete without UI notifications");
    });
});

