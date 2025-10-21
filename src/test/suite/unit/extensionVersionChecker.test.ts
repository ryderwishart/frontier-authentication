import * as assert from "assert";
import { buildOutdatedExtensionsMessage, ExtensionVersionInfo } from "../../../utils/extensionVersionChecker";

suite("extensionVersionChecker message builder", () => {
    test("single extension message format", () => {
        const items: ExtensionVersionInfo[] = [
            {
                extensionId: "frontier-rnd.frontier-authentication",
                currentVersion: "0.4.15",
                latestVersion: "0.4.16",
                isOutdated: true,
                downloadUrl: "",
                displayName: "Frontier Authentication",
            },
        ];
        const msg = buildOutdatedExtensionsMessage(items);
        assert.strictEqual(msg, "To sync, update:\n- Frontier Authentication");
    });

    test("two extensions uses plural message and names", () => {
        const items: ExtensionVersionInfo[] = [
            {
                extensionId: "project-accelerate.codex-editor-extension",
                currentVersion: "0.6.20",
                latestVersion: "0.6.21",
                isOutdated: true,
                downloadUrl: "",
                displayName: "Codex Editor",
            },
            {
                extensionId: "frontier-rnd.frontier-authentication",
                currentVersion: "0.4.15",
                latestVersion: "0.4.16",
                isOutdated: true,
                downloadUrl: "",
                displayName: "Frontier Authentication",
            },
        ];
        const msg = buildOutdatedExtensionsMessage(items);
        assert.strictEqual(msg, "To sync, update:\n- Codex Editor\n- Frontier Authentication");
    });
});


