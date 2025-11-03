import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from '../../../state';

suite('Sync Lock Integration Tests', () => {
    let testWorkspacePath: string;
    let lockFilePath: string;

    suiteSetup(async function() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log('⚠️  No workspace folder available - skipping sync lock integration tests');
            this.skip();
            return;
        }
        testWorkspacePath = workspaceFolders[0].uri.fsPath;
        lockFilePath = path.join(testWorkspacePath, '.git', 'frontier-sync.lock');
        
        // Ensure .git directory exists
        const gitDir = path.join(testWorkspacePath, '.git');
        if (!fs.existsSync(gitDir)) {
            fs.mkdirSync(gitDir, { recursive: true });
        }
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
        const stateManager = StateManager.getInstance();
        try {
            await stateManager.releaseSyncLock();
            if (fs.existsSync(lockFilePath)) {
                fs.unlinkSync(lockFilePath);
            }
        } catch (error) {
            // Ignore
        }
    });

    test('Full sync flow: acquire, heartbeat, release', async function() {
        this.timeout(10000); // Give it more time
        
        const stateManager = StateManager.getInstance();
        
        // 1. Acquire lock
        const acquired = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(acquired, true, 'Lock should be acquired');

        // 2. Simulate heartbeat updates during sync
        const heartbeats: number[] = [];
        
        for (let i = 0; i < 3; i++) {
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: i === 0 ? 'committing' : i === 1 ? 'fetching' : 'pushing'
            });
            
            // Verify lock is active
            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.strictEqual(status.status, 'active', `Heartbeat ${i}: Lock should be active`);
            assert.ok(status.age < 1000, `Heartbeat ${i}: Age should be very recent`);
            
            heartbeats.push(Date.now());
            
            // Wait a bit between heartbeats
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // 3. Release lock
        await stateManager.releaseSyncLock();
        
        // 4. Verify lock is gone
        assert.strictEqual(fs.existsSync(lockFilePath), false, 'Lock should be deleted');
        
        const finalStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
        assert.strictEqual(finalStatus.exists, false, 'Lock check should show no lock');
    });

    test('Concurrent sync attempt detection', async function() {
        this.timeout(5000);
        
        const stateManager = StateManager.getInstance();
        
        // First sync acquires lock
        const firstAcquire = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(firstAcquire, true, 'First sync should acquire lock');

        // Keep heartbeat alive
        await stateManager.updateLockHeartbeat({
            timestamp: Date.now(),
            phase: 'syncing'
        });

        // Second sync should detect active lock
        const lockStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
        assert.strictEqual(lockStatus.exists, true, 'Second sync should see lock');
        assert.strictEqual(lockStatus.status, 'active', 'Lock should be active');

        // Clean up
        await stateManager.releaseSyncLock();
    });

    test('Dead lock recovery', async function() {
        this.timeout(5000);
        
        const stateManager = StateManager.getInstance();
        
        // Create a dead lock (old timestamp, different PID)
        const oldTimestamp = Date.now() - (50 * 1000); // 50 seconds ago
        fs.writeFileSync(lockFilePath, JSON.stringify({
            pid: 99999,
            timestamp: oldTimestamp,
            lastProgress: oldTimestamp,
            phase: 'syncing'
        }));

        // Check it's detected as dead
        const deadStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
        assert.strictEqual(deadStatus.status, 'dead', 'Lock should be detected as dead');

        // Clean it up
        await stateManager.cleanupStaleLock(testWorkspacePath);
        assert.strictEqual(fs.existsSync(lockFilePath), false, 'Dead lock should be cleaned up');

        // New sync should be able to acquire
        const newAcquire = await stateManager.acquireSyncLock(testWorkspacePath);
        assert.strictEqual(newAcquire, true, 'Should be able to acquire after cleanup');

        // Clean up
        await stateManager.releaseSyncLock();
    });

    test('Stuck lock detection during network operation', async function() {
        this.timeout(5000);
        
        const stateManager = StateManager.getInstance();
        
        // Create a lock with recent heartbeat but old progress (simulating network stall)
        const now = Date.now();
        const oldProgress = now - (3 * 60 * 1000); // 3 minutes ago
        fs.writeFileSync(lockFilePath, JSON.stringify({
            pid: process.pid,
            timestamp: now, // Heartbeat is fresh
            lastProgress: oldProgress, // Progress is stale
            phase: 'fetching', // Network operation
            phaseChangedAt: oldProgress
        }));

        // Check it's detected as stuck
        const stuckStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
        assert.strictEqual(stuckStatus.status, 'stuck', 'Lock should be detected as stuck');
        assert.strictEqual(stuckStatus.isStuck, true, 'isStuck flag should be true');

        // In real scenario, user would be prompted to cancel or wait
        // For test, just clean up
        await stateManager.cleanupStaleLock(testWorkspacePath);
    });

    test('Progress tracking through phases', async function() {
        this.timeout(5000);
        
        const stateManager = StateManager.getInstance();
        
        await stateManager.acquireSyncLock(testWorkspacePath);

        // Simulate sync phases with progress
        const phases = [
            { phase: 'committing', progress: { current: 1, total: 1, description: 'Committing changes' } },
            { phase: 'fetching', progress: { current: 50, total: 200, description: 'Fetching objects: 50/200' } },
            { phase: 'fetching', progress: { current: 200, total: 200, description: 'Fetching complete' } },
            { phase: 'pushing', progress: { current: 100, total: 150, description: 'Pushing objects: 100/150' } },
            { phase: 'pushing', progress: { current: 150, total: 150, description: 'Push complete' } }
        ];

        for (const phaseData of phases) {
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: phaseData.phase,
                progress: phaseData.progress
            });

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.strictEqual(status.phase, phaseData.phase, `Phase should be ${phaseData.phase}`);
            assert.ok(status.progress, 'Progress should be present');
            assert.strictEqual(status.progress!.current, phaseData.progress.current, 'Current progress should match');

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        await stateManager.releaseSyncLock();
    });

    test('Startup cleanup removes old lock', async function() {
        this.timeout(5000);
        
        // Create an old lock (simulating leftover from previous session)
        fs.writeFileSync(lockFilePath, JSON.stringify({
            pid: 88888, // Different PID
            timestamp: Date.now() - (1000),
            phase: 'syncing'
        }));

        assert.strictEqual(fs.existsSync(lockFilePath), true, 'Lock file should exist before cleanup');

        // Trigger cleanup (this happens automatically on extension activation)
        // For test, we call it manually
        const stateManager = StateManager.getInstance();
        // The constructor already calls cleanupStaleLockFiles, but we can verify the result
        
        // Since we can't re-instantiate the singleton, we'll just verify cleanup works
        await stateManager.cleanupStaleLock(testWorkspacePath);
        
        assert.strictEqual(fs.existsSync(lockFilePath), false, 'Lock should be removed by cleanup');
    });
});

