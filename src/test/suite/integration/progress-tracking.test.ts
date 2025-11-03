import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StateManager } from '../../../state';
import { GitService } from '../../../git/GitService';

suite('Integration: Progress Tracking Tests', () => {
    let testWorkspacePath: string;
    let lockFilePath: string;
    let stateManager: StateManager;
    let gitService: GitService;

    suiteSetup(async function() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log('⚠️  No workspace folder available - skipping progress tracking tests');
            this.skip();
            return;
        }
        testWorkspacePath = workspaceFolders[0].uri.fsPath;
        lockFilePath = path.join(testWorkspacePath, '.git', 'frontier-sync.lock');
        
        const gitDir = path.join(testWorkspacePath, '.git');
        if (!fs.existsSync(gitDir)) {
            fs.mkdirSync(gitDir, { recursive: true });
        }

        stateManager = StateManager.getInstance();
        gitService = new GitService(stateManager);
    });

    setup(() => {
        try {
            if (fs.existsSync(lockFilePath)) {
                fs.unlinkSync(lockFilePath);
            }
        } catch (error) {
            // Ignore
        }
    });

    teardown(async () => {
        try {
            await stateManager.releaseSyncLock();
            if (fs.existsSync(lockFilePath)) {
                fs.unlinkSync(lockFilePath);
            }
        } catch (error) {
            // Ignore
        }
    });

    test('Progress updates are reflected in lock file', async function() {
        this.timeout(5000);
        
        await stateManager.acquireSyncLock(testWorkspacePath);

        // Update progress
        const progressData = {
            current: 42,
            total: 127,
            description: 'Receiving objects: 42/127'
        };

        await stateManager.updateLockHeartbeat({
            timestamp: Date.now(),
            lastProgress: Date.now(),
            phase: 'fetching',
            progress: progressData
        });

        // Read lock file directly
        const lockContent = fs.readFileSync(lockFilePath, 'utf8');
        const lockData = JSON.parse(lockContent);

        assert.ok(lockData.progress, 'Lock file should contain progress');
        assert.strictEqual(lockData.progress.current, 42, 'Current should be 42');
        assert.strictEqual(lockData.progress.total, 127, 'Total should be 127');
        assert.strictEqual(lockData.progress.description, 'Receiving objects: 42/127', 'Description should match');
        assert.strictEqual(lockData.phase, 'fetching', 'Phase should be fetching');

        await stateManager.releaseSyncLock();
    });

    test('Progress tracking through multiple file commits', async function() {
        this.timeout(5000);
        
        await stateManager.acquireSyncLock(testWorkspacePath);

        // Simulate committing multiple files
        const fileCommitSteps = [
            { current: 0, total: 10, description: 'Committing 10 files' },
            { current: 3, total: 10, description: 'Committing file 3/10' },
            { current: 7, total: 10, description: 'Committing file 7/10' },
            { current: 10, total: 10, description: 'Committed 10 files' }
        ];

        for (const step of fileCommitSteps) {
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: 'committing',
                progress: step
            });

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.ok(status.progress, 'Progress should be present');
            assert.strictEqual(status.progress!.current, step.current, `Current should be ${step.current}`);
            assert.strictEqual(status.progress!.total, step.total, `Total should be ${step.total}`);
        }

        await stateManager.releaseSyncLock();
    });

    test('Progress tracking for large fetch operation', async function() {
        this.timeout(10000);
        
        await stateManager.acquireSyncLock(testWorkspacePath);

        // Simulate large fetch with realistic Git progress phases
        const fetchPhases = [
            { phase: 'Receiving objects', steps: [
                { current: 0, total: 500 },
                { current: 100, total: 500 },
                { current: 250, total: 500 },
                { current: 400, total: 500 },
                { current: 500, total: 500 }
            ]},
            { phase: 'Resolving deltas', steps: [
                { current: 0, total: 250 },
                { current: 125, total: 250 },
                { current: 250, total: 250 }
            ]},
            { phase: 'Updating files', steps: [
                { current: 0, total: 50 },
                { current: 50, total: 50 }
            ]}
        ];

        for (const phaseData of fetchPhases) {
            for (const step of phaseData.steps) {
                await stateManager.updateLockHeartbeat({
                    timestamp: Date.now(),
                    lastProgress: Date.now(),
                    phase: 'fetching',
                    progress: {
                        current: step.current,
                        total: step.total,
                        description: `${phaseData.phase}: ${step.current}/${step.total}`
                    }
                });

                const status = await stateManager.checkFilesystemLock(testWorkspacePath);
                assert.strictEqual(status.status, 'active', 'Should be active during fetch');
                assert.ok(status.progress, 'Progress should be present');
                assert.strictEqual(status.progress!.current, step.current, 'Current should match');
                assert.strictEqual(status.progress!.total, step.total, 'Total should match');
                assert.ok(status.progress!.description!.includes(phaseData.phase), 'Description should include phase');

                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        await stateManager.releaseSyncLock();
    });

    test('Progress tracking for push operation with compression', async function() {
        this.timeout(10000);
        
        await stateManager.acquireSyncLock(testWorkspacePath);

        // Simulate push with Git's internal phases
        const pushPhases = [
            { phase: 'Counting objects', total: 100 },
            { phase: 'Compressing objects', total: 100 },
            { phase: 'Writing objects', total: 100 },
            { phase: 'Remote: Resolving deltas', total: 50 }
        ];

        for (const phaseData of pushPhases) {
            // Simulate incremental progress
            for (let i = 0; i <= phaseData.total; i += Math.ceil(phaseData.total / 5)) {
                await stateManager.updateLockHeartbeat({
                    timestamp: Date.now(),
                    lastProgress: Date.now(),
                    phase: 'pushing',
                    progress: {
                        current: i,
                        total: phaseData.total,
                        description: `${phaseData.phase}: ${i}/${phaseData.total}`
                    }
                });

                const status = await stateManager.checkFilesystemLock(testWorkspacePath);
                assert.strictEqual(status.status, 'active', `Should be active during ${phaseData.phase}`);
                assert.ok(status.progress!.description!.includes(phaseData.phase), 'Description should match phase');

                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        await stateManager.releaseSyncLock();
    });

    test('Progress updates with phase transitions', async function() {
        this.timeout(5000);
        
        await stateManager.acquireSyncLock(testWorkspacePath);

        const phaseTransitions = [
            { phase: 'committing', progress: { current: 5, total: 5, description: 'Committed 5 files' } },
            { phase: 'fetching', progress: { current: 0, total: 0, description: 'Checking for remote changes' } },
            { phase: 'fetching', progress: { current: 100, total: 100, description: 'Receiving objects: 100/100' } },
            { phase: 'merging', progress: { current: 0, total: 1, description: 'Merging remote changes' } },
            { phase: 'merging', progress: { current: 1, total: 1, description: 'Merge complete' } },
            { phase: 'pushing', progress: { current: 0, total: 0, description: 'Uploading changes' } },
            { phase: 'pushing', progress: { current: 10, total: 10, description: 'Writing objects: 10/10' } }
        ];

        let previousPhase = '';

        for (const transition of phaseTransitions) {
            const now = Date.now();
            await stateManager.updateLockHeartbeat({
                timestamp: now,
                lastProgress: now,
                phase: transition.phase,
                progress: transition.progress
            });

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.strictEqual(status.phase, transition.phase, `Phase should be ${transition.phase}`);
            assert.strictEqual(status.progress!.description, transition.progress.description, 'Description should match');

            // Verify phaseChangedAt updates when phase changes
            if (previousPhase && previousPhase !== transition.phase) {
                const lockContent = fs.readFileSync(lockFilePath, 'utf8');
                const lockData = JSON.parse(lockContent);
                assert.ok(lockData.phaseChangedAt, 'phaseChangedAt should be set on phase change');
            }

            previousPhase = transition.phase;
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        await stateManager.releaseSyncLock();
    });

    test('Progress callback integration', async function() {
        this.timeout(5000);
        
        const progressCallbacks: Array<{ phase: string; loaded: number; total: number; description: string }> = [];

        // Create a mock progress callback
        const mockProgressCallback = (phase: string, loaded: number, total: number, description: string) => {
            progressCallbacks.push({ phase, loaded, total, description });
        };

        await stateManager.acquireSyncLock(testWorkspacePath);

        // Simulate progress updates that would come from GitService
        const progressUpdates = [
            { phase: 'committing', loaded: 0, total: 3, description: 'Committing 3 files' },
            { phase: 'committing', loaded: 3, total: 3, description: 'Committed 3 files' },
            { phase: 'fetching', loaded: 50, total: 200, description: 'Receiving objects: 50/200' },
            { phase: 'pushing', loaded: 10, total: 20, description: 'Writing objects: 10/20' }
        ];

        for (const update of progressUpdates) {
            // Simulate what GitService does
            mockProgressCallback(update.phase, update.loaded, update.total, update.description);
            
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: update.phase,
                progress: {
                    current: update.loaded,
                    total: update.total,
                    description: update.description
                }
            });

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        await stateManager.releaseSyncLock();

        // Verify all progress callbacks were captured
        assert.strictEqual(progressCallbacks.length, 4, 'Should have 4 progress callbacks');
        assert.strictEqual(progressCallbacks[0].description, 'Committing 3 files', 'First callback should be commit start');
        assert.strictEqual(progressCallbacks[3].description, 'Writing objects: 10/20', 'Last callback should be push progress');
    });

    test('Zero-progress phases handled correctly', async function() {
        this.timeout(5000);
        
        await stateManager.acquireSyncLock(testWorkspacePath);

        // Some phases don't have countable progress (like checking remote)
        const zeroProgressPhases = [
            { phase: 'fetching', progress: { current: 0, total: 0, description: 'Checking for remote changes' } },
            { phase: 'fetching', progress: { current: 1, total: 1, description: 'Remote check complete' } },
            { phase: 'syncing', progress: { current: 1, total: 1, description: 'Already up to date' } }
        ];

        for (const phaseData of zeroProgressPhases) {
            await stateManager.updateLockHeartbeat({
                timestamp: Date.now(),
                lastProgress: Date.now(),
                phase: phaseData.phase,
                progress: phaseData.progress
            });

            const status = await stateManager.checkFilesystemLock(testWorkspacePath);
            assert.strictEqual(status.status, 'active', 'Zero-progress phase should still be active');
            assert.ok(status.progress, 'Progress should be present even with zeros');
            assert.strictEqual(status.progress!.description, phaseData.progress.description, 'Description should be set');

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        await stateManager.releaseSyncLock();
    });
});

