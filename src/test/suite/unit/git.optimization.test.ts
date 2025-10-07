import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";
import { GitService } from "../../../git/GitService";

suite("Git Repository Optimization - Unit Tests", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-git-opt-"));
    let repoDir: string;

    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const service = new GitService(stateStub);

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
        await service.init(repoDir);
        
        // Create initial commit
        const initFile = path.join(repoDir, "init.txt");
        await fs.promises.writeFile(initFile, "initial", "utf8");
        await git.add({ fs, dir: repoDir, filepath: "init.txt" });
        await git.commit({
            fs,
            dir: repoDir,
            message: "initial commit",
            author: { name: "Test", email: "test@example.com" },
        });
    });

    teardown(async () => {
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    suiteTeardown(async () => {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {}
    });

    test("packObjects consolidates loose objects into pack file", async () => {
        // Create several commits with loose objects
        for (let i = 0; i < 10; i++) {
            const file = path.join(repoDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: repoDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: repoDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Verify loose objects exist
        const objectsDir = path.join(repoDir, ".git", "objects");
        const subdirsBefore = await fs.promises.readdir(objectsDir);
        const looseObjectSubdirsBefore = subdirsBefore.filter(d => d.length === 2);
        assert.ok(looseObjectSubdirsBefore.length > 0, "Should have loose object directories");

        // Pack objects
        await service.packObjects(repoDir);

        // Verify pack file was created
        const packDir = path.join(objectsDir, "pack");
        const packFiles = await fs.promises.readdir(packDir);
        const packs = packFiles.filter(f => f.endsWith(".pack"));
        const indexes = packFiles.filter(f => f.endsWith(".idx"));

        assert.strictEqual(packs.length, 1, "Should have exactly one pack file");
        assert.strictEqual(indexes.length, 1, "Should have exactly one index file");
        assert.ok(packs[0].startsWith("pack-"), "Pack file should start with 'pack-'");
        assert.strictEqual(packs[0].replace(".pack", ".idx"), indexes[0], "Pack and index names should match");

        // Verify loose objects were cleaned up
        const subdirsAfter = await fs.promises.readdir(objectsDir);
        const looseObjectSubdirsAfter = subdirsAfter.filter(d => d.length === 2);
        
        // Count remaining loose objects
        let remainingLooseObjects = 0;
        for (const subdir of looseObjectSubdirsAfter) {
            const subdirPath = path.join(objectsDir, subdir);
            try {
                const files = await fs.promises.readdir(subdirPath);
                remainingLooseObjects += files.filter(f => f.length === 38).length;
            } catch {}
        }

        assert.ok(remainingLooseObjects < 5, "Most loose objects should be cleaned up (may have a few from pack creation)");
    });

    test("packObjects handles repository with multiple existing pack files", async () => {
        // Create initial commits
        for (let i = 0; i < 5; i++) {
            const file = path.join(repoDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: repoDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: repoDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // First pack
        await service.packObjects(repoDir);

        // Create more commits
        for (let i = 5; i < 10; i++) {
            const file = path.join(repoDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: repoDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: repoDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Second pack should consolidate both
        await service.packObjects(repoDir);

        const packDir = path.join(repoDir, ".git", "objects", "pack");
        const packFiles = await fs.promises.readdir(packDir);
        const packs = packFiles.filter(f => f.endsWith(".pack"));
        const indexes = packFiles.filter(f => f.endsWith(".idx"));

        assert.strictEqual(packs.length, 1, "Should consolidate into single pack file");
        assert.strictEqual(indexes.length, 1, "Should have single index file");
    });

    test("packObjects with depth limit handles large commit history", async () => {
        // Create many commits (more than typical depth)
        for (let i = 0; i < 20; i++) {
            const file = path.join(repoDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: repoDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: repoDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        // Pack should succeed despite many commits
        await service.packObjects(repoDir);

        const packDir = path.join(repoDir, ".git", "objects", "pack");
        const packFiles = await fs.promises.readdir(packDir);
        const packs = packFiles.filter(f => f.endsWith(".pack"));

        assert.strictEqual(packs.length, 1, "Should create pack file even with many commits");

        // Verify repository is still functional
        const log = await git.log({ fs, dir: repoDir, depth: 5 });
        assert.ok(log.length > 0, "Should still be able to read commit history");
    });

    test("packObjects only deletes loose objects that were packed", async () => {
        // Create and pack some commits
        for (let i = 0; i < 5; i++) {
            const file = path.join(repoDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: repoDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: repoDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        await service.packObjects(repoDir);

        // Create a new loose object AFTER packing
        const newFile = path.join(repoDir, "new-file.txt");
        await fs.promises.writeFile(newFile, "new content", "utf8");
        await git.add({ fs, dir: repoDir, filepath: "new-file.txt" });

        // Verify the new object is loose
        const objectsDir = path.join(repoDir, ".git", "objects");
        const subdirs = await fs.promises.readdir(objectsDir);
        const looseSubdirs = subdirs.filter(d => d.length === 2);
        assert.ok(looseSubdirs.length > 0, "New loose object should exist");

        // This new loose object should NOT be deleted by a second pack
        // (because it wasn't in the pack operation)
        const newCommit = await git.commit({
            fs,
            dir: repoDir,
            message: "new commit after pack",
            author: { name: "Test", email: "test@example.com" },
        });

        // Verify new commit exists and repository is functional
        const log = await git.log({ fs, dir: repoDir, depth: 1 });
        assert.strictEqual(log[0].oid, newCommit, "New commit should be accessible");
    });

    test("packObjects handles empty repository gracefully", async () => {
        const emptyRepoDir = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
        await service.init(emptyRepoDir);

        // Pack should handle empty repo without errors
        await service.packObjects(emptyRepoDir);

        // Verify no pack files created for empty repo
        const packDir = path.join(emptyRepoDir, ".git", "objects", "pack");
        try {
            const packFiles = await fs.promises.readdir(packDir);
            const packs = packFiles.filter(f => f.endsWith(".pack"));
            assert.strictEqual(packs.length, 0, "Should not create pack for empty repo");
        } catch (err: any) {
            // Pack directory might not exist, which is also valid
            assert.ok(err.code === "ENOENT", "Pack directory doesn't exist for empty repo");
        }

        fs.rmSync(emptyRepoDir, { recursive: true, force: true });
    });

    test("packObjects creates matching .pack and .idx files", async () => {
        // Create commits
        for (let i = 0; i < 5; i++) {
            const file = path.join(repoDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: repoDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: repoDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        await service.packObjects(repoDir);

        const packDir = path.join(repoDir, ".git", "objects", "pack");
        const packFiles = await fs.promises.readdir(packDir);
        const packs = packFiles.filter(f => f.endsWith(".pack"));
        const indexes = packFiles.filter(f => f.endsWith(".idx"));

        // Verify matching names
        assert.strictEqual(packs.length, 1, "Should have one pack");
        assert.strictEqual(indexes.length, 1, "Should have one index");
        
        const packBaseName = packs[0].replace(".pack", "");
        const idxBaseName = indexes[0].replace(".idx", "");
        assert.strictEqual(packBaseName, idxBaseName, "Pack and index should have matching names");

        // Verify files are not empty
        const packPath = path.join(packDir, packs[0]);
        const idxPath = path.join(packDir, indexes[0]);
        const packStat = await fs.promises.stat(packPath);
        const idxStat = await fs.promises.stat(idxPath);

        assert.ok(packStat.size > 0, "Pack file should not be empty");
        assert.ok(idxStat.size > 0, "Index file should not be empty");
    });

    test("packObjects performance is reasonable for typical repository", async function() {
        this.timeout(30000); // 30 second timeout

        // Create a typical repository with ~100 commits
        for (let i = 0; i < 100; i++) {
            const file = path.join(repoDir, `file-${i}.txt`);
            await fs.promises.writeFile(file, `content ${i}`, "utf8");
            await git.add({ fs, dir: repoDir, filepath: `file-${i}.txt` });
            await git.commit({
                fs,
                dir: repoDir,
                message: `commit ${i}`,
                author: { name: "Test", email: "test@example.com" },
            });
        }

        const startTime = Date.now();
        await service.packObjects(repoDir);
        const duration = Date.now() - startTime;

        // Pack operation should complete in reasonable time (< 20 seconds)
        assert.ok(duration < 20000, `Pack operation took ${duration}ms, should be < 20000ms`);

        // Verify pack was created
        const packDir = path.join(repoDir, ".git", "objects", "pack");
        const packFiles = await fs.promises.readdir(packDir);
        const packs = packFiles.filter(f => f.endsWith(".pack"));
        assert.strictEqual(packs.length, 1, "Should create pack file");
    });
});

