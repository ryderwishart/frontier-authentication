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
        assert.ok(msg.includes("Frontier Authentication is on v0.4.16"));
        assert.ok(msg.includes("you have v0.4.15 installed"));
        assert.ok(msg.includes("To enable syncing, please update."));
    });

    test("multiple extensions stacked with blank line", () => {
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
        // Each section present
        assert.ok(msg.includes("Codex Editor is on v0.6.21"));
        assert.ok(msg.includes("To enable syncing, please update."));
        assert.ok(msg.includes("Frontier Authentication is on v0.4.16"));
        assert.ok(msg.includes("To enable syncing, please update."));
        // Sections separated by a blank line
        const parts = msg.split("\n\n");
        assert.ok(parts.length >= 2);
    });
});


