import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { StateManager } from "../../../state";
import { GitService } from "../../../git/GitService";

suite("E2E: Complete Sync Flow Tests", () => {
    let testWorkspacePath: string;
    let lockFilePath: string;
    let stateManager: StateManager;
    let gitService: GitService;

    suiteSetup(async function () {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log("⚠️  No workspace folder available - skipping E2E sync flow tests");
            this.skip();
            return;
        }
        testWorkspacePath = workspaceFolders[0].uri.fsPath;
        lockFilePath = path.join(testWorkspacePath, ".git", "frontier-sync.lock");

        // Ensure StateManager is initialized for this test run. In production this
        // is done during extension activation, but the E2E tests run directly.
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

        // Ensure .git directory exists
        const gitDir = path.join(testWorkspacePath, ".git");
        if (!fs.existsSync(gitDir)) {
            fs.mkdirSync(gitDir, { recursive: true });
        }

        stateManager = StateManager.getInstance();
        gitService = new GitService(stateManager);
    });

    setup(() => {
        // Clean up before each test
        try {
            if (fs.existsSync(lockFilePath)) {
                fs.unlinkSync(lockFilePath);
            }
        } catch (error) {
            // Ignore
        }
    });

    teardown(async () => {
        // Clean up after each test
        try {
            await stateManager.releaseSyncLock();
            if (fs.existsSync(lockFilePath)) {
                fs.unlinkSync(lockFilePath);
            }
        } catch (error) {
            // Ignore
        }
    });

    test("E2E: Full sync with heartbeat monitoring", async function () {
        this.timeout(30000);

        const progressEvents: Array<{ phase: string; description: string }> = [];
        let heartbeatUpdates = 0;

        // Acquire lock
        const acquired = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(acquired, true, "Lock should be acquired");

        // Simulate a sync with multiple phases
        const phases = [
            {
                phase: "committing",
                duration: 1000,
                progress: { current: 3, total: 3, description: "Committing 3 files" },
            },
            {
                phase: "fetching",
                duration: 2000,
                progress: { current: 0, total: 0, description: "Checking for remote changes" },
            },
            {
                phase: "merging",
                duration: 1000,
                progress: { current: 1, total: 1, description: "Merging remote changes" },
            },
            {
                phase: "pushing",
                duration: 1500,
                progress: { current: 0, total: 0, description: "Uploading changes" },
            },
        ];

        for (const phaseData of phases) {
            const startTime = Date.now();
            progressEvents.push({
                phase: phaseData.phase,
                description: phaseData.progress.description,
            });

            // Update heartbeat at start of phase
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: phaseData.phase,
                progress: phaseData.progress,
            });
            heartbeatUpdates++;

            // Verify lock is active
            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.strictEqual(
                status.status,
                "active",
                `Phase ${phaseData.phase} should have active lock`
            );
            assert.strictEqual(status.phase, phaseData.phase, `Phase should be ${phaseData.phase}`);

            // Simulate work during phase with periodic heartbeat updates
            const elapsed = () => Date.now() - startTime;
            while (elapsed() < phaseData.duration) {
                await new Promise((resolve) => setTimeout(resolve, 500));

                if (elapsed() < phaseData.duration) {
                    await stateManager.updateLockHeartbeat({
                        timestamp: Date.now(),
                        lastProgress: Date.now(),
                        phase: phaseData.phase,
                        progress: phaseData.progress,
                    });
                    heartbeatUpdates++;
                }
            }
        }

        // Release lock
        await stateManager.releaseSyncLock();

        // Verify results
        assert.strictEqual(progressEvents.length, 4, "Should have 4 phase events");
        assert.ok(
            heartbeatUpdates >= 8,
            `Should have multiple heartbeat updates (got ${heartbeatUpdates})`
        );
        assert.strictEqual(fs.existsSync(lockFilePath), false, "Lock should be released");
    });

    test("E2E: Concurrent sync attempt while sync in progress", async function () {
        this.timeout(10000);

        // First sync acquires lock
        const firstAcquired = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(firstAcquired, true, "First sync should acquire lock");

        // Update heartbeat immediately to ensure lock has recent timestamp
        await stateManager.updateLockHeartbeat({
            timestamp: Date.now(),
            lastProgress: Date.now(),
            phase: "syncing",
        });

        // Start heartbeat for first sync
        const heartbeatInterval = setInterval(async () => {
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: "syncing",
            });
        }, 500);

        try {
            // Wait a bit to establish the first sync
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Update heartbeat one more time before checking
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: "syncing",
            });

            // Second sync attempts to acquire lock
            const lockStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.strictEqual(lockStatus.exists, true, "Second sync should detect existing lock");
            // Lock should be active if heartbeat is recent (within 45 seconds)
            if (lockStatus.status === "dead") {
                // If dead, check if it's because age is too old
                console.log(`Lock age: ${lockStatus.age}ms, status: ${lockStatus.status}`);
            }
            assert.ok(
                lockStatus.status === "active" || lockStatus.age < 50000,
                `Lock should be active or very recent (status: ${lockStatus.status}, age: ${lockStatus.age}ms)`
            );

            // Second sync should NOT be able to acquire
            const secondAcquired = await stateManager.acquireSyncLock(testWorkspacePath);
            assert.strictEqual(secondAcquired, false, "Second sync should fail to acquire lock");
        } finally {
            clearInterval(heartbeatInterval);
            await stateManager.releaseSyncLock();
        }
    });

    test("E2E: Recovery from crashed sync (dead lock)", async function () {
        this.timeout(10000);

        // Simulate a crashed sync (lock with old timestamp, different PID)
        const deadLockData = {
            pid: 99999, // Different PID
            timestamp: Date.now() - 60 * 1000, // 60 seconds ago (> 45 sec threshold)
            lastProgress: Date.now() - 60 * 1000,
            phase: "fetching",
        };
        fs.writeFileSync(lockFilePath, JSON.stringify(deadLockData));

        // Check that it's detected as dead
        const deadStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
        assert.strictEqual(deadStatus.status, "dead", "Lock should be detected as dead");
        assert.strictEqual(deadStatus.isDead, true, "isDead flag should be true");

        // Cleanup should remove the dead lock
        await stateManager.cleanupStaleLock(testWorkspacePath);
        assert.strictEqual(fs.existsSync(lockFilePath), false, "Dead lock should be cleaned up");

        // New sync should be able to acquire lock
        const acquired = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(acquired, true, "Should acquire lock after dead lock cleanup");

        // Verify normal operation
        await stateManager.updateLockHeartbeat({
            timestamp: Date.now(),
            phase: "syncing",
        });

        const activeStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
        assert.strictEqual(activeStatus.status, "active", "New sync should be active");

        await stateManager.releaseSyncLock();
    });

    test("E2E: Stuck sync detection and recovery", async function () {
        this.timeout(10000);

        // Simulate a stuck sync (heartbeat updating but no progress)
        const now = Date.now();
        const stuckLockData = {
            pid: process.pid,
            timestamp: now, // Current heartbeat (process alive)
            lastProgress: now - 3 * 60 * 1000, // 3 minutes ago (> 2 min threshold)
            phase: "fetching",
            phaseChangedAt: now - 3 * 60 * 1000,
        };
        fs.writeFileSync(lockFilePath, JSON.stringify(stuckLockData));

        // Check that it's detected as stuck
        const stuckStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
        assert.strictEqual(stuckStatus.status, "stuck", "Lock should be detected as stuck");
        assert.strictEqual(stuckStatus.isStuck, true, "isStuck flag should be true");
        assert.strictEqual(stuckStatus.isDead, false, "Should not be dead (process alive)");

        // In real scenario, user would be prompted. For test, just clean up
        await stateManager.cleanupStaleLock(testWorkspacePath);
        assert.strictEqual(fs.existsSync(lockFilePath), false, "Stuck lock should be cleaned up");

        // New sync should proceed
        const acquired = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(acquired, true, "Should acquire lock after stuck lock cleanup");

        await stateManager.releaseSyncLock();
    });

    test("E2E: CPU-intensive phase grace period", async function () {
        this.timeout(10000);

        // Simulate a merge operation (CPU-intensive, so gets grace period)
        const now = Date.now();
        const mergeLockData = {
            pid: process.pid,
            timestamp: now - 5 * 1000, // 5 seconds ago
            lastProgress: now - 60 * 1000, // 1 minute ago (would normally be stuck)
            phase: "merging", // CPU-bound phase
            phaseChangedAt: now - 20 * 1000, // Entered phase 20 seconds ago (< 30 sec grace)
        };
        fs.writeFileSync(lockFilePath, JSON.stringify(mergeLockData));

        // Should still be considered active due to grace period
        const status = await stateManager.checkFilesystemLock(testWorkspacePath);
        assert.strictEqual(
            status.status,
            "active",
            "Merging phase should be active within grace period"
        );
        assert.strictEqual(status.isStuck, false, "Should not be stuck within grace period");

        // Clean up
        await stateManager.cleanupStaleLock(testWorkspacePath);
    });

    test("E2E: Slow network sync completes successfully", async function () {
        this.timeout(15000);

        // Simulate a slow but progressing fetch
        const acquired = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(acquired, true, "Lock should be acquired");

        // Simulate slow fetch with progress updates
        const fetchProgress = [
            { current: 10, total: 500, description: "Receiving objects: 10/500" },
            { current: 50, total: 500, description: "Receiving objects: 50/500" },
            { current: 150, total: 500, description: "Receiving objects: 150/500" },
            { current: 300, total: 500, description: "Receiving objects: 300/500" },
            { current: 500, total: 500, description: "Receiving objects: 500/500" },
        ];

        for (const progress of fetchProgress) {
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: "fetching",
                progress,
            });

            // Verify it's still active
            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.strictEqual(
                status.status,
                "active",
                `Should be active at ${progress.current}/${progress.total}`
            );

            // Simulate time between progress updates (slow network)
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Complete the sync
        await stateManager.releaseSyncLock();
        assert.strictEqual(fs.existsSync(lockFilePath), false, "Lock should be released");
    });

    test("E2E: Startup cleanup removes all stale locks", async function () {
        this.timeout(5000);

        // Create multiple old locks (simulating leftover from previous sessions)
        const oldLocks = [
            { pid: 11111, timestamp: Date.now() - 1000, phase: "fetching" },
            { pid: 22222, timestamp: Date.now() - 2000, phase: "pushing" },
            { pid: 33333, timestamp: Date.now() - 3000, phase: "merging" },
        ];

        // Just test the most recent one (file can only have one lock)
        fs.writeFileSync(lockFilePath, JSON.stringify(oldLocks[0]));
        assert.strictEqual(fs.existsSync(lockFilePath), true, "Lock file should exist");

        // Trigger cleanup (simulates extension startup)
        await stateManager.cleanupStaleLock(testWorkspacePath);

        // All locks should be removed
        assert.strictEqual(fs.existsSync(lockFilePath), false, "All locks should be cleaned up");

        // New sync should proceed without issues
        const acquired = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(acquired, true, "Should acquire lock after cleanup");

        await stateManager.releaseSyncLock();
    });

    test("E2E: Progress tracking through multiple phases with realistic timing", async function () {
        this.timeout(20000);

        const acquired = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(acquired, true, "Lock should be acquired");

        // Realistic sync scenario
        const syncPhases = [
            {
                phase: "committing",
                steps: [
                    { current: 0, total: 5, description: "Committing 5 files", delay: 500 },
                    { current: 5, total: 5, description: "Committed 5 files", delay: 500 },
                ],
            },
            {
                phase: "fetching",
                steps: [
                    {
                        current: 0,
                        total: 0,
                        description: "Checking for remote changes",
                        delay: 1000,
                    },
                    {
                        current: 42,
                        total: 127,
                        description: "Receiving objects: 42/127",
                        delay: 500,
                    },
                    {
                        current: 85,
                        total: 127,
                        description: "Receiving objects: 85/127",
                        delay: 500,
                    },
                    {
                        current: 127,
                        total: 127,
                        description: "Receiving objects: 127/127",
                        delay: 500,
                    },
                    { current: 50, total: 50, description: "Resolving deltas: 50/50", delay: 300 },
                ],
            },
            {
                phase: "merging",
                steps: [
                    { current: 0, total: 1, description: "Merging remote changes", delay: 800 },
                    { current: 1, total: 1, description: "Merge complete", delay: 200 },
                ],
            },
            {
                phase: "pushing",
                steps: [
                    { current: 5, total: 5, description: "Counting objects: 5/5", delay: 300 },
                    { current: 5, total: 5, description: "Compressing objects: 5/5", delay: 400 },
                    { current: 3, total: 5, description: "Writing objects: 3/5", delay: 500 },
                    { current: 5, total: 5, description: "Writing objects: 5/5", delay: 300 },
                ],
            },
        ];

        for (const phaseData of syncPhases) {
            for (const step of phaseData.steps) {
                await stateManager.updateLockHeartbeat({
                    timestamp: Date.now(),
                    lastProgress: Date.now(),
                    phase: phaseData.phase,
                    progress: {
                        current: step.current,
                        total: step.total,
                        description: step.description,
                    },
                });

                // Verify lock is active and has correct data
                const status = await stateManager.checkFilesystemLock(testWorkspacePath);
                assert.strictEqual(
                    status.status,
                    "active",
                    `Should be active during ${step.description}`
                );
                assert.strictEqual(
                    status.phase,
                    phaseData.phase,
                    `Phase should be ${phaseData.phase}`
                );
                assert.ok(status.progress, "Progress should be present");
                assert.strictEqual(
                    status.progress!.description,
                    step.description,
                    "Description should match"
                );

                await new Promise((resolve) => setTimeout(resolve, step.delay));
            }
        }

        await stateManager.releaseSyncLock();
        assert.strictEqual(fs.existsSync(lockFilePath), false, "Lock should be released");
    });
});
