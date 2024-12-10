import * as path from 'path';
import * as cp from 'child_process';

import {
    downloadAndUnzipVSCode,
    resolveCliArgsFromVSCodeExecutablePath,
    runTests
} from '@vscode/test-electron';

async function main() {
    try {
        // The folder containing the Extension Manifest package.json
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');

        // The path to test runner
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // Download VS Code, unzip it and run the integration test
        const vscodeExecutablePath = await downloadAndUnzipVSCode();
        const [cliPath, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

        // Run the extension test
        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                '--disable-extensions', // Disable other extensions
                '--disable-telemetry', // Disable telemetry
                '--user-data-dir', // Use a clean user data directory
                path.resolve(__dirname, './test-user-data'),
            ],
            extensionTestsEnv: {
                VSCODE_TEST_MODE: 'true', // Signal that we're running in test mode
                NODE_ENV: 'test',
            },
        });
    } catch (err) {
        console.error('Failed to run tests');
        process.exit(1);
    }
}

main();
