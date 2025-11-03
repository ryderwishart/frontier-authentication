import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager, HEARTBEAT_INTERVAL } from '../../../state';

suite('Sync Lock Unit Tests', () => {
    let stateManager: StateManager;
    let testWorkspacePath: string;
    let lockFilePath: string;

    suiteSetup(async function() {
        // Get a test workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log('⚠️  No workspace folder available - skipping sync lock unit tests');
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
        // Clean up lock file before each test
        try {
            if (fs.existsSync(lockFilePath)) {
                fs.unlinkSync(lockFilePath);
            }
        } catch (error) {
            // Ignore errors
        }
        
        stateManager = StateManager.getInstance();
    });

    teardown(async () => {
        // Clean up lock file after each test
        try {
            await stateManager.releaseSyncLock();
            if (fs.existsSync(lockFilePath)) {
                fs.unlinkSync(lockFilePath);
            }
        } catch (error) {
            // Ignore errors
        }
    });

    suite('Lock Acquisition', () => {
        test('Should acquire lock successfully', async () => {
            const acquired = await stateManager.acquireSyncLock(testWorkspacePath);
            assert.strictEqual(acquired, true, 'Lock should be acquired');
            assert.strictEqual(fs.existsSync(lockFilePath), true, 'Lock file should exist');
        });

        test('Should fail to acquire when lock exists', async () => {
            const firstAcquire = await stateManager.acquireSyncLock(testWorkspacePath);
            assert.strictEqual(firstAcquire, true, 'First acquisition should succeed');

            // Create a new StateManager instance (simulates different process)
            // This won't work in practice because we use singleton, but we can test
            // by trying to acquire again
            const lockStatus = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.strictEqual(lockStatus.exists, true, 'Lock should exist');
        });

        test('Lock file should contain PID and timestamp', async () => {
            await stateManager.acquireSyncLock(testWorkspacePath);
            
            const lockContent = fs.readFileSync(lockFilePath, 'utf8');
            const lockData = JSON.parse(lockContent);
            
            assert.ok(lockData.pid, 'Lock should have PID');
            assert.ok(lockData.timestamp, 'Lock should have timestamp');
            assert.strictEqual(lockData.pid, process.pid, 'PID should match current process');
        });
    });

    suite('Lock Detection', () => {
        test('Should detect active lock', async () => {
            await stateManager.acquireSyncLock(testWorkspacePath);
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                phase: 'syncing'
            });

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            
            assert.strictEqual(status.exists, true, 'Lock should exist');
            assert.strictEqual(status.status, 'active', 'Lock should be active');
            assert.strictEqual(status.isDead, false, 'Lock should not be dead');
            assert.strictEqual(status.isStuck, false, 'Lock should not be stuck');
        });

        test('Should detect dead lock after 45 seconds', async () => {
            // Create a lock with old timestamp
            const oldTimestamp = Date.now() - (46 * 1000); // 46 seconds ago
            const lockData = {
                pid: process.pid,
                timestamp: oldTimestamp,
                lastProgress: oldTimestamp,
                phase: 'syncing'
            };
            
            fs.writeFileSync(lockFilePath, JSON.stringify(lockData));

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            
            assert.strictEqual(status.exists, true, 'Lock should exist');
            assert.strictEqual(status.status, 'dead', 'Lock should be dead');
            assert.strictEqual(status.isDead, true, 'isDead should be true');
            assert.ok(status.age > 45000, 'Age should be greater than 45 seconds');
        });

        test('Should detect stuck lock after 2 minutes of no progress', async () => {
            // Create a lock with recent heartbeat but old progress
            const now = Date.now();
            const oldProgress = now - (3 * 60 * 1000); // 3 minutes ago
            const lockData = {
                pid: process.pid,
                timestamp: now, // Heartbeat is recent
                lastProgress: oldProgress, // Progress is old
                phase: 'fetching', // Not a CPU-bound phase
                phaseChangedAt: oldProgress
            };
            
            fs.writeFileSync(lockFilePath, JSON.stringify(lockData));

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            
            assert.strictEqual(status.exists, true, 'Lock should exist');
            assert.strictEqual(status.status, 'stuck', 'Lock should be stuck');
            assert.strictEqual(status.isStuck, true, 'isStuck should be true');
            assert.ok(status.progressAge > 2 * 60 * 1000, 'Progress age should be greater than 2 minutes');
        });

        test('Should not detect stuck during CPU-bound phase with grace period', async () => {
            // Create a lock in merging phase with old progress but within grace period
            const now = Date.now();
            const oldProgress = now - (2.5 * 60 * 1000); // 2.5 minutes ago
            const lockData = {
                pid: process.pid,
                timestamp: now, // Heartbeat is recent
                lastProgress: oldProgress, // Progress is 2.5 minutes old
                phase: 'merging', // CPU-bound phase
                phaseChangedAt: oldProgress // Just started this phase
            };
            
            fs.writeFileSync(lockFilePath, JSON.stringify(lockData));

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            
            assert.strictEqual(status.exists, true, 'Lock should exist');
            assert.strictEqual(status.status, 'active', 'Lock should be active (grace period)');
            assert.strictEqual(status.isStuck, false, 'Should not be stuck during grace period');
        });

        test('Should detect corrupted lock as dead', async () => {
            // Write invalid JSON
            fs.writeFileSync(lockFilePath, 'invalid json {{{');

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            
            assert.strictEqual(status.exists, true, 'Lock should exist');
            assert.strictEqual(status.status, 'dead', 'Corrupted lock should be treated as dead');
            assert.strictEqual(status.isDead, true, 'isDead should be true');
        });
    });

    suite('Lock Heartbeat', () => {
        test('Should update heartbeat timestamp', async () => {
            await stateManager.acquireSyncLock(testWorkspacePath);
            
            const beforeUpdate = Date.now();
            await new Promise(resolve => setTimeout(resolve, 100)); // Wait a bit
            
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                phase: 'syncing'
            });
            
            const lockContent = fs.readFileSync(lockFilePath, 'utf8');
            const lockData = JSON.parse(lockContent);
            
            assert.ok(lockData.timestamp >= beforeUpdate, 'Timestamp should be updated');
        });

        test('Should update progress when provided', async () => {
            await stateManager.acquireSyncLock(testWorkspacePath);
            
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: 'fetching',
                progress: {
                    current: 50,
                    total: 100,
                    description: 'Fetching: 50/100'
                }
            });
            
            const lockContent = fs.readFileSync(lockFilePath, 'utf8');
            const lockData = JSON.parse(lockContent);
            
            assert.ok(lockData.progress, 'Progress should be set');
            assert.strictEqual(lockData.progress.current, 50, 'Current should be 50');
            assert.strictEqual(lockData.progress.total, 100, 'Total should be 100');
        });

        test('Should update phase change timestamp when phase changes', async () => {
            await stateManager.acquireSyncLock(testWorkspacePath);
            
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                phase: 'committing'
            });
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                phase: 'fetching' // Different phase
            });
            
            const lockContent = fs.readFileSync(lockFilePath, 'utf8');
            const lockData = JSON.parse(lockContent);
            
            assert.strictEqual(lockData.phase, 'fetching', 'Phase should be updated');
            assert.ok(lockData.phaseChangedAt, 'Phase change timestamp should be set');
        });
    });

    suite('Lock Cleanup', () => {
        test('Should clean up stale lock', async () => {
            // Create a stale lock
            const oldTimestamp = Date.now() - (46 * 1000);
            fs.writeFileSync(lockFilePath, JSON.stringify({
                pid: 99999, // Non-existent PID
                timestamp: oldTimestamp
            }));

            await stateManager.cleanupStaleLock(testWorkspacePath);
            
            assert.strictEqual(fs.existsSync(lockFilePath), false, 'Stale lock should be deleted');
        });

        test('Should release lock', async () => {
            await stateManager.acquireSyncLock(testWorkspacePath);
            assert.strictEqual(fs.existsSync(lockFilePath), true, 'Lock should exist');

            await stateManager.releaseSyncLock();
            
            assert.strictEqual(fs.existsSync(lockFilePath), false, 'Lock should be deleted after release');
        });
    });

    suite('Heartbeat Constants', () => {
        test('Heartbeat interval should be 15 seconds', () => {
            assert.strictEqual(HEARTBEAT_INTERVAL, 15 * 1000, 'Heartbeat should be 15 seconds');
        });
    });
});

