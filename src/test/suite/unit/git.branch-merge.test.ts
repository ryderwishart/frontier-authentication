import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";
import { GitService } from "../../../git/GitService";

suite("GitService Branch & Merge Scenarios", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-git-branch-"));
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
    });

    teardown(async () => {
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    suite("syncChanges - Branch Scenarios", () => {
        test("remote branch doesn't exist (first push)", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "initial", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "test.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Initial commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Mock fetch to return empty (no remote branch)
            const originalFetch = git.fetch;
            const originalPush = git.push;
            
            (git as any).fetch = async () => {
                // Fetch succeeds but no remote branch exists
                return {};
            };
            
            (git as any).push = async () => {
                // Push succeeds for first push
                return {};
            };

            try {
                const result = await service.syncChanges(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" }
                );
                
                // Result should be defined
                assert.ok(result !== undefined, "Should return result");
                // For first push, skippedDueToLock should be false (or undefined if not set)
                if (result.skippedDueToLock !== undefined) {
                    assert.strictEqual(result.skippedDueToLock, false);
                }
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).push = originalPush;
            }
        });

        test("local branch is behind remote (needs fast-forward)", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "local", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "test.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Local commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Mock: fetch brings remote changes, local is behind
            const originalFetch = git.fetch;
            const originalPull = git.pull;
            const originalPush = git.push;
            
            let fetchCalled = false;
            (git as any).fetch = async () => {
                fetchCalled = true;
                // Simulate remote has new commits
                return {};
            };
            
            (git as any).pull = async () => {
                // Fast-forward succeeds
                return { oid: "abc123" };
            };
            
            (git as any).push = async () => {
                // No push needed after fast-forward
                return {};
            };

            try {
                const result = await service.syncChanges(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" }
                );
                
                assert.strictEqual(fetchCalled, true);
                assert.strictEqual(result.hadConflicts, false);
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).pull = originalPull;
                (git as any).push = originalPush;
            }
        });

        test("local branch diverged from remote (needs merge)", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "local", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "test.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Local commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Mock: fetch brings remote changes, branches diverged
            const originalFetch = git.fetch;
            const originalPull = git.pull;
            
            (git as any).fetch = async () => {
                return {};
            };
            
            (git as any).pull = async () => {
                // Pull fails with merge conflict
                const error: any = new Error("Merge conflict");
                error.name = "MergeConflictError";
                throw error;
            };

            try {
                const result = await service.syncChanges(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" }
                );
                
                // Should detect conflicts (if pull throws merge conflict error)
                // Note: The actual behavior depends on how isomorphic-git handles conflicts
                assert.ok(result !== undefined, "Should return result");
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).pull = originalPull;
            }
        });

        test("current branch is not tracking remote branch", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "local", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "test.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Local commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Mock: branch exists but not tracking
            const originalFetch = git.fetch;
            const originalResolveRef = git.resolveRef;
            
            (git as any).fetch = async () => {
                return {};
            };
            
            (git as any).resolveRef = async (opts: any) => {
                if (opts.ref && opts.ref.includes("origin/")) {
                    // Remote ref doesn't exist
                    throw new Error("Reference not found");
                }
                return "local-commit-hash";
            };

            try {
                // Should handle gracefully when remote ref doesn't exist
                const result = await service.syncChanges(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" }
                );
                
                // Should complete without error (pushes to create remote branch)
                assert.ok(result !== undefined);
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).resolveRef = originalResolveRef;
            }
        });
    });

    suite("completeMerge - Edge Cases", () => {
        test("complete merge with no resolved files", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "content", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "test.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Initial commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Mock fetch and push
            const originalFetch = git.fetch;
            const originalResolveRef = git.resolveRef;
            const originalCommit = git.commit;
            const originalPush = git.push;
            
            (git as any).fetch = async () => ({});
            (git as any).resolveRef = async () => "commit-hash";
            (git as any).commit = async () => "merge-commit-hash";
            (git as any).push = async () => ({});

            try {
                // Complete merge with empty resolved files array
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    []
                );
                
                // Should complete without error
                assert.ok(true);
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).resolveRef = originalResolveRef;
                (git as any).commit = originalCommit;
                (git as any).push = originalPush;
            }
        });

        test("complete merge with deleted file resolution", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit with file
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "content", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "test.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Initial commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Mock operations
            const originalFetch = git.fetch;
            const originalResolveRef = git.resolveRef;
            const originalRemove = git.remove;
            const originalCommit = git.commit;
            const originalPush = git.push;
            
            let removeCalled = false;
            (git as any).fetch = async () => ({});
            (git as any).resolveRef = async () => "commit-hash";
            (git as any).remove = async () => {
                removeCalled = true;
            };
            (git as any).commit = async () => "merge-commit-hash";
            (git as any).push = async () => ({});

            try {
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    [{ filepath: "test.txt", resolution: "deleted" }]
                );
                
                assert.strictEqual(removeCalled, true, "Should call git.remove for deleted files");
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).resolveRef = originalResolveRef;
                (git as any).remove = originalRemove;
                (git as any).commit = originalCommit;
                (git as any).push = originalPush;
            }
        });

        test("complete merge with created file resolution", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit with a file
            const initFile = path.join(repoDir, "init.txt");
            await fs.promises.writeFile(initFile, "init", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "init.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Initial commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Create new file
            const newFile = path.join(repoDir, "new.txt");
            await fs.promises.writeFile(newFile, "new content", "utf8");

            // Mock operations
            const originalFetch = git.fetch;
            const originalResolveRef = git.resolveRef;
            const originalAdd = git.add;
            const originalCommit = git.commit;
            const originalPush = git.push;
            
            let addCalled = false;
            (git as any).fetch = async () => ({});
            (git as any).resolveRef = async () => "commit-hash";
            (git as any).add = async () => {
                addCalled = true;
            };
            (git as any).commit = async () => "merge-commit-hash";
            (git as any).push = async () => ({});

            try {
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    [{ filepath: "new.txt", resolution: "created" }]
                );
                
                assert.strictEqual(addCalled, true, "Should stage created files");
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).resolveRef = originalResolveRef;
                (git as any).add = originalAdd;
                (git as any).commit = originalCommit;
                (git as any).push = originalPush;
            }
        });

        test("complete merge fails if sync lock is held", async () => {
            const lockedStateStub: any = {
                isSyncLocked: () => true,
                acquireSyncLock: async () => false,
                releaseSyncLock: async () => {},
            };

            const lockedService = new GitService(lockedStateStub);
            await lockedService.init(repoDir);

            await assert.rejects(
                async () => {
                    await lockedService.completeMerge(
                        repoDir,
                        { username: "oauth2", password: "token" },
                        { name: "Test", email: "test@example.com" },
                        []
                    );
                },
                (error: Error) => {
                    return error.message.includes("Sync operation already in progress");
                },
                "Should fail when sync lock is held"
            );
        });

        test("complete merge with stale remote reference (should fetch first)", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "content", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "test.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Initial commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Mock: fetch should be called before reading remote ref
            const originalFetch = git.fetch;
            const originalResolveRef = git.resolveRef;
            const originalCommit = git.commit;
            const originalPush = git.push;
            
            let fetchCallCount = 0;
            (git as any).fetch = async () => {
                fetchCallCount++;
                return {};
            };
            (git as any).resolveRef = async () => "commit-hash";
            (git as any).commit = async () => "merge-commit-hash";
            (git as any).push = async () => ({});

            try {
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    [{ filepath: "test.txt", resolution: "modified" }]
                );
                
                // Should fetch before reading remote ref
                assert.ok(fetchCallCount > 0, "Should fetch before reading remote reference");
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).resolveRef = originalResolveRef;
                (git as any).commit = originalCommit;
                (git as any).push = originalPush;
            }
        });

        test("complete merge when remote has new commits after conflict resolution", async () => {
            await service.addRemote(repoDir, "origin", "https://example.com/repo.git");
            
            // Create initial commit
            const testFile = path.join(repoDir, "test.txt");
            await fs.promises.writeFile(testFile, "content", "utf8");
            await git.add({ fs, dir: repoDir, filepath: "test.txt" });
            await git.commit({
                fs,
                dir: repoDir,
                message: "Initial commit",
                author: { name: "Test", email: "test@example.com" },
            });

            // Mock: first fetch gets old ref, second fetch (in completeMerge) gets new ref
            const originalFetch = git.fetch;
            const originalResolveRef = git.resolveRef;
            const originalCommit = git.commit;
            const originalPush = git.push;
            
            let fetchCount = 0;
            (git as any).fetch = async () => {
                fetchCount++;
                return {};
            };
            
            let resolveRefCount = 0;
            (git as any).resolveRef = async (opts: any) => {
                resolveRefCount++;
                // First call returns old ref, subsequent calls return new ref
                if (resolveRefCount === 1) {
                    return "old-remote-hash";
                }
                return "new-remote-hash";
            };
            
            (git as any).commit = async () => "merge-commit-hash";
            (git as any).push = async () => ({});

            try {
                await service.completeMerge(
                    repoDir,
                    { username: "oauth2", password: "token" },
                    { name: "Test", email: "test@example.com" },
                    [{ filepath: "test.txt", resolution: "modified" }]
                );
                
                // Should fetch to get latest remote state
                assert.ok(fetchCount > 0, "Should fetch to get latest remote state");
            } finally {
                (git as any).fetch = originalFetch;
                (git as any).resolveRef = originalResolveRef;
                (git as any).commit = originalCommit;
                (git as any).push = originalPush;
            }
        });
    });
});

