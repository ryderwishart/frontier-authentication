import * as vscode from "vscode";
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

        const metadataPath = vscode.Uri.joinPath(workspaceFolder.uri, "metadata.json");

        let metadata: ProjectMetadata;
        try {
            const metadataContent = await vscode.workspace.fs.readFile(metadataPath);
            metadata = JSON.parse(new TextDecoder().decode(metadataContent));
        } catch (error) {
            console.warn("[MetadataVersionChecker] ❌ Could not read metadata.json:", error);
            return { canSync: false, metadataUpdated: false, reason: "Could not read metadata file" };
        }

        const meta = (metadata.meta ??= {} as MetaSection);

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

        if (!meta.requiredExtensions) {
            debug("[MetadataVersionChecker] ➕ Adding extension version requirements to metadata");
            meta.requiredExtensions = {
                codexEditor: codexEditorVersion,
                frontierAuthentication: frontierAuthVersion,
            };

            await saveMetadata(metadataPath, metadata);

            debug("[MetadataVersionChecker] ✅ Added current extension versions to metadata");
            return { canSync: true, metadataUpdated: true };
        }

        const metadataCodexVersion = meta.requiredExtensions.codexEditor;
        const metadataFrontierVersion = meta.requiredExtensions.frontierAuthentication;

        debug("[MetadataVersionChecker] 📋 Metadata requires:");
        debug(`  - Codex Editor: ${metadataCodexVersion || "not set"}`);
        debug(`  - Frontier Authentication: ${metadataFrontierVersion || "not set"}`);

        let metadataUpdated = false;
        const outdatedExtensions: ExtensionVersionInfo[] = [];

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
                meta.requiredExtensions.codexEditor = codexEditorVersion;
                metadataUpdated = true;
            }
        } else {
            debug("[MetadataVersionChecker] ➕ Setting Codex Editor version in metadata");
            meta.requiredExtensions = meta.requiredExtensions || {};
            meta.requiredExtensions.codexEditor = codexEditorVersion;
            metadataUpdated = true;
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
                meta.requiredExtensions.frontierAuthentication = frontierAuthVersion;
                metadataUpdated = true;
            }
        } else {
            debug("[MetadataVersionChecker] ➕ Setting Frontier Authentication version in metadata");
            meta.requiredExtensions = meta.requiredExtensions || {};
            meta.requiredExtensions.frontierAuthentication = frontierAuthVersion;
            metadataUpdated = true;
        }

        if (metadataUpdated) {
            await saveMetadata(metadataPath, metadata);
            debug("[MetadataVersionChecker] 💾 Metadata updated with latest extension versions");
        }

        const canSync = outdatedExtensions.length === 0;
        if (!canSync) {
            console.warn(
                `[MetadataVersionChecker] 🚫 Sync blocked due to ${outdatedExtensions.length} outdated extension(s)`
            );
            return {
                canSync: false,
                metadataUpdated,
                reason: `Extensions need updating: ${outdatedExtensions
                    .map((ext) => `${ext.displayName} (${ext.currentVersion} → ${ext.latestVersion})`)
                    .join(", ")}`,
                needsUserAction: true,
                outdatedExtensions,
            };
        }

        debug("[MetadataVersionChecker] ✅ All extension versions compatible with metadata");
        return { canSync: true, metadataUpdated };
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

async function saveMetadata(metadataPath: vscode.Uri, metadata: ProjectMetadata): Promise<void> {
    const metadataContent = JSON.stringify(metadata, null, 4);
    await vscode.workspace.fs.writeFile(metadataPath, new TextEncoder().encode(metadataContent));
}

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

async function showMetadataVersionMismatchNotification(
    context: vscode.ExtensionContext,
    outdatedExtensions: ExtensionVersionInfo[]
): Promise<boolean> {
    const extensionNames = outdatedExtensions.map((ext) => ext.displayName).join(" and ");
    const message =
        outdatedExtensions.length === 1
            ? `${extensionNames} needs to be updated to enable syncing.`
            : `${extensionNames} need to be updated to enable syncing.`;

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

export function registerVersionCheckCommands(_context: vscode.ExtensionContext): void {
    // Reserved for future commands related to version checking
}


