import * as vscode from "vscode";
import { MetadataManager } from "./metadataManager";
// Lightweight version comparator to avoid external semver dependency
export function compareVersions(a: string, b: string): number {
    const normalize = (v: string) => v.trim().replace(/^v/i, "");
    const parse = (v: string) => normalize(v).split(".").map((x) => parseInt(x, 10));
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const ai = pa[i] ?? 0;
        const bi = pb[i] ?? 0;
        if (ai > bi) return 1;
        if (ai < bi) return -1;
    }
    return 0;
}

const DEBUG_MODE = false;
const debug = (message: string) => {
    if (DEBUG_MODE) {
        console.log(`[ExtensionVersionChecker] ${message}`);
    }
};

interface ProjectMetadata {
    meta?: {
        requiredExtensions?: {
            codexEditor?: string;
            frontierAuthentication?: string;
        };
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

type MetaSection = {
    requiredExtensions?: {
        codexEditor?: string;
        frontierAuthentication?: string;
    };
    [key: string]: unknown;
};

export interface ExtensionVersionInfo {
    extensionId: string;
    currentVersion: string;
    latestVersion: string;
    isOutdated: boolean;
    downloadUrl: string;
    displayName: string;
}

const VERSION_MODAL_COOLDOWN_KEY = "codex-editor.versionModalLastShown";
const VERSION_MODAL_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

function getCurrentExtensionVersion(extensionId: string): string | null {
    const extension = vscode.extensions.getExtension(extensionId);
    return (extension as any)?.packageJSON?.version || null;
}

export function getInstalledExtensionVersions(): {
    codexEditorVersion: string | null;
    frontierAuthVersion: string | null;
} {
    const codexEditorVersion = getCurrentExtensionVersion(
        "project-accelerate.codex-editor-extension"
    );
    const frontierAuthVersion = getCurrentExtensionVersion(
        "frontier-rnd.frontier-authentication"
    );
    return { codexEditorVersion, frontierAuthVersion };
}

interface MetadataVersionCheckResult {
    canSync: boolean;
    metadataUpdated: boolean;
    reason?: string;
    needsUserAction?: boolean;
    outdatedExtensions?: ExtensionVersionInfo[];
}

export async function checkAndUpdateMetadataVersions(): Promise<MetadataVersionCheckResult> {
    try {
        debug("[MetadataVersionChecker] ═══ METADATA VERSION CHECK ═══");

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            console.warn("[MetadataVersionChecker] ❌ No workspace folder found");
            return { canSync: false, metadataUpdated: false, reason: "No workspace folder" };
        }

        const codexEditorVersion = getCurrentExtensionVersion("project-accelerate.codex-editor-extension");
        const frontierAuthVersion = getCurrentExtensionVersion("frontier-rnd.frontier-authentication");

        debug("[MetadataVersionChecker] 📦 Current versions:");
        debug(`  - Codex Editor: ${codexEditorVersion || "not found"}`);
        debug(`  - Frontier Authentication: ${frontierAuthVersion || "not found"}`);

        if (!codexEditorVersion || !frontierAuthVersion) {
            const missingExtensions: string[] = [];
            if (!codexEditorVersion) missingExtensions.push("Codex Editor");
            if (!frontierAuthVersion) missingExtensions.push("Frontier Authentication");

            console.error(
                `[MetadataVersionChecker] ❌ Missing required extensions: ${missingExtensions.join(", ")}`
            );
            return {
                canSync: false,
                metadataUpdated: false,
                reason: `Missing required extensions: ${missingExtensions.join(", ")}`,
                needsUserAction: true,
            };
        }

        // Use MetadataManager to safely read current versions
        const currentVersionsResult = await MetadataManager.getExtensionVersions(workspaceFolder.uri);
        if (!currentVersionsResult.success) {
            console.warn("[MetadataVersionChecker] ❌ Could not read metadata.json:", currentVersionsResult.error);
            return { canSync: false, metadataUpdated: false, reason: "Could not read metadata file" };
        }

        const currentVersions = currentVersionsResult.versions || {};
        const metadataCodexVersion = currentVersions.codexEditor;
        const metadataFrontierVersion = currentVersions.frontierAuthentication;

        debug("[MetadataVersionChecker] 📋 Metadata requires:");
        debug(`  - Codex Editor: ${metadataCodexVersion || "not set"}`);
        debug(`  - Frontier Authentication: ${metadataFrontierVersion || "not set"}`);

        let needsUpdate = false;
        const outdatedExtensions: ExtensionVersionInfo[] = [];
        const versionsToUpdate: { codexEditor?: string; frontierAuthentication?: string } = {};

        // Check if versions need updating
        if (!metadataCodexVersion || !metadataFrontierVersion) {
            debug("[MetadataVersionChecker] ➕ Adding missing extension version requirements to metadata");
            needsUpdate = true;
            if (!metadataCodexVersion) versionsToUpdate.codexEditor = codexEditorVersion;
            if (!metadataFrontierVersion) versionsToUpdate.frontierAuthentication = frontierAuthVersion;
        }

        if (metadataCodexVersion) {
            if (compareVersions(codexEditorVersion, metadataCodexVersion) < 0) {
                console.warn(
                    `[MetadataVersionChecker] ⚠️  Codex Editor outdated: ${codexEditorVersion} < ${metadataCodexVersion}`
                );
                outdatedExtensions.push({
                    extensionId: "project-accelerate.codex-editor-extension",
                    currentVersion: codexEditorVersion,
                    latestVersion: metadataCodexVersion,
                    isOutdated: true,
                    downloadUrl: "",
                    displayName: "Codex Editor",
                });
            } else if (compareVersions(codexEditorVersion, metadataCodexVersion) > 0) {
                debug(
                    `[MetadataVersionChecker] 🚀 Updating Codex Editor version: ${metadataCodexVersion} → ${codexEditorVersion}`
                );
                versionsToUpdate.codexEditor = codexEditorVersion;
                needsUpdate = true;
            }
        }

        if (metadataFrontierVersion) {
            if (compareVersions(frontierAuthVersion, metadataFrontierVersion) < 0) {
                console.warn(
                    `[MetadataVersionChecker] ⚠️  Frontier Authentication outdated: ${frontierAuthVersion} < ${metadataFrontierVersion}`
                );
                outdatedExtensions.push({
                    extensionId: "frontier-rnd.frontier-authentication",
                    currentVersion: frontierAuthVersion,
                    latestVersion: metadataFrontierVersion,
                    isOutdated: true,
                    downloadUrl: "",
                    displayName: "Frontier Authentication",
                });
            } else if (compareVersions(frontierAuthVersion, metadataFrontierVersion) > 0) {
                debug(
                    `[MetadataVersionChecker] 🚀 Updating Frontier Authentication version: ${metadataFrontierVersion} → ${frontierAuthVersion}`
                );
                versionsToUpdate.frontierAuthentication = frontierAuthVersion;
                needsUpdate = true;
            }
        }

        // Safely update metadata if needed
        if (needsUpdate) {
            const updateResult = await MetadataManager.updateExtensionVersions(workspaceFolder.uri, versionsToUpdate);
            if (!updateResult.success) {
                console.error("[MetadataVersionChecker] ❌ Failed to update metadata:", updateResult.error);
                return {
                    canSync: false,
                    metadataUpdated: false,
                    reason: `Failed to update metadata: ${updateResult.error}`,
                };
            }
            debug("[MetadataVersionChecker] 💾 Metadata updated with latest extension versions");
        }

        const canSync = outdatedExtensions.length === 0;
        if (!canSync) {
            console.warn(
                `[MetadataVersionChecker] 🚫 Sync blocked due to ${outdatedExtensions.length} outdated extension(s)`
            );
            return {
                canSync: false,
                metadataUpdated: needsUpdate,
                reason: `Extensions need updating: ${outdatedExtensions
                    .map((ext) => `${ext.displayName} (${ext.currentVersion} → ${ext.latestVersion})`)
                    .join(", ")}`,
                needsUserAction: true,
                outdatedExtensions,
            };
        }

        debug("[MetadataVersionChecker] ✅ All extension versions compatible with metadata");
        return { canSync: true, metadataUpdated: needsUpdate };
    } catch (error) {
        console.error("[MetadataVersionChecker] ❌ Error during metadata version check:", error);
        return {
            canSync: false,
            metadataUpdated: false,
            reason: `Version check failed: ${(error as Error).message}`,
        };
    } finally {
        debug("[MetadataVersionChecker] ═══ END METADATA VERSION CHECK ═══\n");
    }
}

// saveMetadata function removed - now using MetadataManager for thread-safe operations

function shouldShowVersionModal(context: vscode.ExtensionContext, isManualSync: boolean): boolean {
    if (isManualSync) {
        debug("[VersionModalCooldown] Manual sync - showing modal");
        return true;
    }

    const lastShown = context.workspaceState.get<number>(VERSION_MODAL_COOLDOWN_KEY, 0);
    const now = Date.now();
    const timeSinceLastShown = now - lastShown;

    if (timeSinceLastShown >= VERSION_MODAL_COOLDOWN_MS) {
        debug(
            `[VersionModalCooldown] Auto-sync - cooldown expired (${Math.round(timeSinceLastShown / 1000 / 60)} minutes ago), showing modal`
        );
        return true;
    } else {
        const remainingMs = VERSION_MODAL_COOLDOWN_MS - timeSinceLastShown;
        const remainingMinutes = Math.round(remainingMs / 1000 / 60);
        debug(
            `[VersionModalCooldown] Auto-sync - in cooldown period, ${remainingMinutes} minutes remaining`
        );
        return false;
    }
}

async function updateVersionModalTimestamp(context: vscode.ExtensionContext): Promise<void> {
    await context.workspaceState.update(VERSION_MODAL_COOLDOWN_KEY, Date.now());
    debug("[VersionModalCooldown] Updated last shown timestamp");
}

export async function resetVersionModalCooldown(context: vscode.ExtensionContext): Promise<void> {
    await context.workspaceState.update(VERSION_MODAL_COOLDOWN_KEY, 0);
    debug("[VersionModalCooldown] Reset cooldown timestamp on extension activation");
}

export function buildOutdatedExtensionsMessage(outdatedExtensions: ExtensionVersionInfo[]): string {
    const names = outdatedExtensions.map((e) => e.displayName);

    const formatNames = (arr: string[]): string => {
        if (arr.length <= 1) return arr[0] || "";
        if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
        return `${arr.slice(0, -1).join(", ")}, and ${arr[arr.length - 1]}`;
    };

    if (names.length === 0) return "To sync, update:"; // safety fallback
    const bullets = names.map((n) => `- ${n}`).join("\n");
    return `To sync, update:\n${bullets}`;
}

async function showMetadataVersionMismatchNotification(
    context: vscode.ExtensionContext,
    outdatedExtensions: ExtensionVersionInfo[]
): Promise<boolean> {
    const message = buildOutdatedExtensionsMessage(outdatedExtensions);

    const actions = ["Update Extensions"];

    try {
        const selection = await vscode.window.showWarningMessage(message, { modal: true }, ...actions);

        switch (selection) {
            case "Update Extensions":
                await vscode.commands.executeCommand("workbench.view.extensions");
                for (const ext of outdatedExtensions) {
                    vscode.window
                        .showInformationMessage(
                            `Update ${ext.displayName} from v${ext.currentVersion} to v${ext.latestVersion}`,
                            "Search in Extensions"
                        )
                        .then((choice) => {
                            if (choice === "Search in Extensions") {
                                vscode.commands.executeCommand(
                                    "workbench.extensions.search",
                                    ext.extensionId
                                );
                            }
                        });
                }

                await updateVersionModalTimestamp(context);
                return false;

            default:
                return false;
        }
    } catch (error) {
        console.error("[MetadataVersionChecker] Error showing notification:", error);
        return false;
    }
}

export async function handleOutdatedExtensionsForSync(
    context: vscode.ExtensionContext,
    outdatedExtensions: ExtensionVersionInfo[],
    isManualSync: boolean
): Promise<boolean> {
    const shouldShow = shouldShowVersionModal(context, isManualSync);
    if (shouldShow) {
        return await showMetadataVersionMismatchNotification(context, outdatedExtensions);
    } else {
        debug(
            "[MetadataVersionChecker] Auto-sync blocked due to outdated extensions (in cooldown period)"
        );
        return false;
    }
}

export async function checkMetadataVersionsForSync(
    context: vscode.ExtensionContext,
    isManualSync: boolean = false
): Promise<boolean> {
    const result = await checkAndUpdateMetadataVersions();

    if (result.canSync) {
        return true;
    }

    if (result.needsUserAction && result.outdatedExtensions) {
        const shouldShow = shouldShowVersionModal(context, isManualSync);

        if (shouldShow) {
            return await showMetadataVersionMismatchNotification(context, result.outdatedExtensions);
        } else {
            debug(
                "[MetadataVersionChecker] Auto-sync blocked due to outdated extensions (in cooldown period)"
            );
            return false;
        }
    }

    console.warn("[MetadataVersionChecker] Sync not allowed:", result.reason);
    return false;
}

export function registerVersionCheckCommands(context: vscode.ExtensionContext): void {
    // Generic check command that other extensions (e.g., Codex) can call
    // to enforce the same blocking modal used for sync before performing
    // media operations (download/stream) or other actions.
    vscode.commands.registerCommand(
        "frontier.checkMetadataVersionsForSync",
        async (options?: { isManualSync?: boolean }): Promise<boolean> => {
            const isManual = !!options?.isManualSync;
            try {
                const allowed = await checkMetadataVersionsForSync(context, isManual);
                return !!allowed;
            } catch (err) {
                console.error("[VersionCheck] Error while checking metadata versions:", err);
                return false;
            }
        }
    );

    // Lightweight command to check remote metadata.json for requiredExtensions
    // and report whether the local installed extensions are behind remote.
    // Returns boolean: true if mismatch detected (block), false if OK
    vscode.commands.registerCommand(
        "frontier.checkRemoteMetadataVersionMismatch",
        async (): Promise<boolean> => {
            try {
                const { SCMManager } = await import("../scm/SCMManager");
                // Create a temporary SCMManager-like instance to reuse logic
                const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspacePath) return true;

                // Mimic the remote metadata fetch/check from SCMManager.syncChanges
                const { getInstalledExtensionVersions } = await import("./extensionVersionChecker");
                const { compareVersions } = await import("./extensionVersionChecker");
                const { GitService } = await import("../git/GitService");
                const state = (await import("../state")).StateManager.getInstance();
                const gitService = new GitService(state);

                // Fetch remote refs and read remote metadata.json (best effort)
                try {
                    const git = await import("isomorphic-git");
                    const fs = (await import("fs")).promises as any;
                    const http = (await import("isomorphic-git/http/node")).default;
                    // We don't have direct token access here; rely on default remote credentials if embedded
                    await git.fetch({ fs, http, dir: workspacePath } as any);
                } catch {}

                let mismatch = false;
                try {
                    const git = await import("isomorphic-git");
                    const fs = (await import("fs")).promises as any;
                    const currentBranch = await git.currentBranch({ fs, dir: workspacePath });
                    if (currentBranch) {
                        const remoteRef = `refs/remotes/origin/${currentBranch}`;
                        let remoteHead: string | undefined;
                        try { remoteHead = await git.resolveRef({ fs, dir: workspacePath, ref: remoteRef }); } catch {}
                        if (remoteHead) {
                            try {
                                const result = await git.readBlob({ fs, dir: workspacePath, oid: remoteHead, filepath: "metadata.json" });
                                const text = new TextDecoder().decode(result.blob);
                                const remoteMetadata = JSON.parse(text) as { meta?: { requiredExtensions?: { codexEditor?: string; frontierAuthentication?: string } } };
                                const required = remoteMetadata.meta?.requiredExtensions;
                                if (required) {
                                    const { codexEditorVersion, frontierAuthVersion } = getInstalledExtensionVersions();
                                    if (required.codexEditor && codexEditorVersion && compareVersions(codexEditorVersion, required.codexEditor) < 0) mismatch = true;
                                    if (required.frontierAuthentication && frontierAuthVersion && compareVersions(frontierAuthVersion, required.frontierAuthentication) < 0) mismatch = true;
                                }
                            } catch {}
                        }
                    }
                } catch {}

                return mismatch;
            } catch (err) {
                console.warn("checkRemoteMetadataVersionMismatch failed:", err);
                return true; // fail closed
            }
        }
    );
}


