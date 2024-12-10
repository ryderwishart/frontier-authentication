import * as path from "path";
import Mocha from "mocha";
import { sync as globSync } from "glob";
import * as fs from "fs";

export function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: "tdd",
        color: true,
        timeout: 60000, // Increased timeout for integration tests
    });

    const testsRoot = path.resolve(__dirname);

    return new Promise((resolve, reject) => {
        try {
            const files = globSync("**/**.test.js", { cwd: testsRoot });

            // Add files to the test suite
            files.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));

            // Run the mocha test
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            console.error(err);
            reject(err);
        }
    });
}

process.on("exit", () => {
    const testUserDataDir = path.resolve(__dirname, "../../test-data");
    if (fs.existsSync(testUserDataDir)) {
        try {
            fs.rmSync(testUserDataDir, { recursive: true, force: true });
        } catch (error) {
            // Ignore cleanup errors on exit
        }
    }
});
