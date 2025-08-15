import * as git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import lfs from "@fetsorn/isogit-lfs";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";

import { StateManager } from "../state";
import {
    UploadBlobsOptions,
    LFSBatchRequest,
    LFSBatchResponse,
    LfsPointerInfo,
} from "../types/lfs";

/**
 * Standalone debug logging function that checks VS Code configuration
 */
function debugLog(message: string, data?: any): void {
    const debugLogging = vscode.workspace
        .getConfiguration("frontier")
        .get("debugGitLogging", false);

    if (debugLogging) {
        if (data !== undefined) {
            console.log(message, JSON.stringify(data));
        } else {
            console.log(message);
        }
    }
}

export interface ConflictedFile {
    filepath: string;
    ours: string;
    theirs: string;
    base: string;
    isNew?: boolean;
    isDeleted?: boolean;
}

export interface SyncResult {
    hadConflicts: boolean;
    conflicts?: ConflictedFile[];
    offline?: boolean;
}

export enum RemoteBranchStatus {
    FOUND,
    NOT_FOUND,
    ERROR,
}

/**
 * Fixed validation function that properly handles GitLab LFS responses
 */
function isValidLFSInfoResponseData(val: unknown): val is LFSBatchResponse {
    try {
        // Check if response has the expected structure
        const maybe = val as Partial<LFSBatchResponse> | undefined;
        if (!maybe || !Array.isArray(maybe.objects)) {
            console.warn("[LFS Patch] Invalid response structure:", val);
            return false;
        }

        const obj = maybe.objects[0];
        if (!obj) {
            console.warn("[LFS Patch] No objects in response");
            return false;
        }

        // If there are no actions, it means the server already has the file
        if (!obj.actions) {
            debugLog("[LFS Patch] Server already has file (no actions needed)");
            return true;
        }

        // Check if upload action has required properties
        const uploadAction = obj.actions?.upload;
        if (!uploadAction) {
            console.warn("[LFS Patch] No upload action in response");
            return false;
        }

        // Check if href exists and is a string (the original bug was here)
        if (!uploadAction.href || typeof uploadAction.href !== "string") {
            console.warn(
                "[LFS Patch] Invalid or missing href in upload action:",
                uploadAction.href
            );
            return false;
        }

        debugLog("[LFS Patch] Response validation passed");
        return true;
    } catch (error) {
        console.error("[LFS Patch] Error validating response:", error);
        return false;
    }
}
/**
 * replace @fetsorn/isogit-lfs uploadBlobs function with corrected validation
 */
async function uploadBlobsToLFSBucket(
    { headers = {}, url, auth }: UploadBlobsOptions,
    contents: Uint8Array[]
): Promise<LfsPointerInfo[]> {
    debugLog("[LFS Patch] Using patched uploadBlobs function");
    debugLog("[LFS Patch] URL:", url);
    debugLog("[LFS Patch] Auth object:", auth);

    // Use the original library's buildPointerInfo function
    const buildPointerInfo = (lfs as any).buildPointerInfo;
    const getAuthHeader = (lfs as any).getAuthHeader || (() => ({}));

    if (!buildPointerInfo) {
        throw new Error("Unable to access buildPointerInfo from LFS library");
    }

    const infos = (await Promise.all(
        contents.map((c: Uint8Array) => buildPointerInfo(c))
    )) as LfsPointerInfo[];

    // Build authentication headers - handle the auth object properly
    let authHeaders: Record<string, string> = {};
    if (auth) {
        if (auth.username && auth.password) {
            // Basic authentication
            const credentials = `${auth.username}:${auth.password}`;
            authHeaders.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
            debugLog("[LFS Patch] Using Basic auth for user:", auth.username);
        } else if (auth.token) {
            // Token authentication
            authHeaders.Authorization = `Bearer ${auth.token}`;
            debugLog("[LFS Patch] Using Bearer token auth");
        } else {
            // Try the library's getAuthHeader as fallback
            authHeaders = getAuthHeader(auth);
            debugLog("[LFS Patch] Using library's auth method");
        }
    } else {
        debugLog("[LFS Patch] No authentication provided");
    }

    // Request LFS transfer
    const lfsInfoRequestData: LFSBatchRequest = {
        operation: "upload",
        transfers: ["basic"],
        objects: infos.map((pi) => ({
            oid: String((pi as any).oid ?? pi["oid"]),
            size: Number((pi as any).size ?? 0),
        })),
    };

    debugLog("[LFS Patch] Making request to:", `${url}/info/lfs/objects/batch`);
    debugLog("[LFS Patch] Request data:", lfsInfoRequestData);
    debugLog("[LFS Patch] Auth headers:", Object.keys(authHeaders));

    const lfsInfoRes = await fetch(`${url}/info/lfs/objects/batch`, {
        method: "POST",
        headers: {
            ...headers,
            ...authHeaders,
            Accept: "application/vnd.git-lfs+json",
            "Content-Type": "application/vnd.git-lfs+json",
        },
        body: JSON.stringify(lfsInfoRequestData),
    });

    if (!lfsInfoRes.ok) {
        const errorText = await lfsInfoRes.text();
        console.error("[LFS Patch] Request failed:");
        console.error("Status:", lfsInfoRes.status, lfsInfoRes.statusText);
        console.error("Response:", errorText);
        console.error("Request URL:", `${url}/info/lfs/objects/batch`);
        console.error("Request headers:", { ...headers, ...authHeaders });
        throw new Error(
            `LFS request failed with status ${lfsInfoRes.status}: ${lfsInfoRes.statusText}\nResponse: ${errorText}`
        );
    }

    const lfsInfoResponseData = (await lfsInfoRes.json()) as unknown;
    debugLog("[LFS Patch] Server response:", lfsInfoResponseData);

    // Use our fixed validation
    if (!isValidLFSInfoResponseData(lfsInfoResponseData)) {
        console.error("[LFS Patch] Invalid response data:", lfsInfoResponseData);
        throw new Error("Unexpected JSON structure received for LFS upload request");
    }

    // Upload each object
    const responseData = lfsInfoResponseData as LFSBatchResponse;
    await Promise.all(
        responseData.objects.map(async (object, index: number) => {
            // Server already has file
            if (!object.actions) {
                debugLog(`[LFS Patch] Server already has file ${index}`);
                return;
            }

            const { actions } = object;
            const upload = actions.upload;
            if (!upload?.href) {
                debugLog(`[LFS Patch] No upload action provided for file ${index}`);
                return;
            }

            debugLog(`[LFS Patch] Uploading file ${index} to:`, upload.href);
            debugLog(`[LFS Patch] Upload headers for file ${index}:`, {
                ...headers,
                ...authHeaders,
                ...(upload.header ?? {}),
                // Don't override Content-Type if it's set by the server
                ...(upload.header?.["Content-Type"]
                    ? {}
                    : { "Content-Type": "application/octet-stream" }),
            });
            debugLog(`[LFS Patch] File size:`, `${contents[index].length} bytes`);

            try {
                // Use the specific headers provided by GitLab for the upload
                // These include the proper authentication for the LFS storage
                const uploadHeaders: Record<string, string> = {
                    ...headers,
                    // Use GitLab's provided headers (which include auth)
                    ...(upload.header ?? {}),
                    // Only add Content-Type if not already specified
                    ...(upload.header?.["Content-Type"]
                        ? {}
                        : { "Content-Type": "application/octet-stream" }),
                };

                // Remove headers that Node.js fetch doesn't allow to be set manually
                delete uploadHeaders["Transfer-Encoding"];
                delete uploadHeaders["Content-Length"];

                debugLog(`[LFS Patch] Final upload headers:`, uploadHeaders);

                // Create AbortController for timeout handling
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout

                const resp = await fetch(upload.href, {
                    method: "PUT",
                    headers: uploadHeaders,
                    body: contents[index],
                    signal: controller.signal,
                    // Add keepalive for large uploads
                    keepalive: false,
                });

                clearTimeout(timeoutId);

                if (!resp.ok) {
                    const errorText = await resp.text();
                    console.error(`[LFS Patch] Upload failed for file ${index}:`);
                    console.error("Status:", resp.status, resp.statusText);
                    console.error("Response:", errorText);
                    throw new Error(
                        `Upload failed for file ${index}, HTTP ${resp.status}: ${resp.statusText}\nResponse: ${errorText}`
                    );
                }

                debugLog(`[LFS Patch] File ${index} uploaded successfully`);
            } catch (fetchError: any) {
                console.error(`[LFS Patch] Network error uploading file ${index}:`, fetchError);
                console.error(`[LFS Patch] Error details:`, {
                    message: fetchError.message,
                    cause: fetchError.cause,
                    code: fetchError.code,
                    stack: fetchError.stack,
                });

                // Log the cause in more detail if it exists
                if (fetchError.cause) {
                    console.error(`[LFS Patch] Error cause details:`, {
                        message: fetchError.cause.message,
                        code: fetchError.cause.code,
                        errno: fetchError.cause.errno,
                        syscall: fetchError.cause.syscall,
                        address: fetchError.cause.address,
                        port: fetchError.cause.port,
                        stack: fetchError.cause.stack,
                    });
                }

                // Provide more helpful error messages based on the error type
                if (
                    fetchError.message?.includes("certificate") ||
                    fetchError.message?.includes("SSL") ||
                    fetchError.message?.includes("TLS")
                ) {
                    throw new Error(
                        `SSL/Certificate error uploading to LFS storage. This may be a self-signed certificate issue. Original error: ${fetchError.message}`
                    );
                } else if (
                    fetchError.message?.includes("ECONNREFUSED") ||
                    fetchError.message?.includes("ENOTFOUND")
                ) {
                    throw new Error(
                        `Network connection error uploading to LFS storage. Check if the LFS storage server is accessible. Original error: ${fetchError.message}`
                    );
                } else if (fetchError.message?.includes("timeout")) {
                    throw new Error(
                        `Upload timeout to LFS storage. The file may be too large or the connection too slow. Original error: ${fetchError.message}`
                    );
                } else {
                    throw new Error(
                        `Network error uploading to LFS storage: ${fetchError.message}`
                    );
                }
            }

            // Handle verification if required
            if (actions.verify) {
                debugLog(`[LFS Patch] Verifying file ${index}`);
                const verificationResp = await fetch(actions.verify.href, {
                    method: "POST",
                    headers: {
                        ...(actions.verify.header ?? {}),
                        Accept: "application/vnd.git-lfs+json",
                        "Content-Type": "application/vnd.git-lfs+json",
                    },
                    body: JSON.stringify({
                        oid: String((infos[index] as any).oid ?? ""),
                        size: Number((infos[index] as any).size ?? 0),
                    }),
                });

                if (!verificationResp.ok) {
                    throw new Error(
                        `Verification failed for file ${index}, HTTP ${verificationResp.status}: ${verificationResp.statusText}`
                    );
                }
            }
        })
    );

    debugLog("[LFS Patch] Upload completed successfully");
    return infos;
}

/**
 * Download a single LFS object using the batch API and returned download action
 */
async function downloadLFSObject(
    {
        headers = {},
        url,
        auth,
    }: {
        headers?: Record<string, string>;
        url: string;
        auth?: { username?: string; password?: string; token?: string };
    },
    object: { oid: string; size: number },
    options?: { maxPointerDepth?: number }
): Promise<Uint8Array> {
    const authHeaders: Record<string, string> = {
        "User-Agent": "curl/7.54", // Helpful for certain servers [[memory:5628983]]
    };

    if (auth) {
        if (auth.username && auth.password) {
            const credentials = `${auth.username}:${auth.password}`;
            authHeaders.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
        } else if (auth.token) {
            authHeaders.Authorization = `Bearer ${auth.token}`;
        }
    }

    const batchBody: LFSBatchRequest = {
        operation: "download",
        transfers: ["basic"],
        objects: [
            {
                oid: object.oid,
                size: object.size,
            },
        ],
    };

    const batchResp = await fetch(`${url}/info/lfs/objects/batch`, {
        method: "POST",
        headers: {
            ...headers,
            ...authHeaders,
            Accept: "application/vnd.git-lfs+json",
            "Content-Type": "application/vnd.git-lfs+json",
        },
        body: JSON.stringify(batchBody),
    });

    if (!batchResp.ok) {
        const errorText = await batchResp.text();
        throw new Error(
            `LFS download batch failed: ${batchResp.status} ${batchResp.statusText}\nResponse: ${errorText}`
        );
    }

    const data = (await batchResp.json()) as LFSBatchResponse;
    const obj = data.objects?.[0];
    const download = obj?.actions?.download;
    if (!download?.href) {
        throw new Error("LFS download action missing in batch response");
    }

    const dlHeaders: Record<string, string> = {
        ...headers,
        ...(download.header ?? {}),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    const fileResp = await fetch(download.href, {
        method: "GET",
        headers: dlHeaders,
        signal: controller.signal,
        keepalive: false,
    });
    clearTimeout(timeoutId);

    if (!fileResp.ok) {
        const errorText = await fileResp.text();
        throw new Error(
            `LFS object download failed: ${fileResp.status} ${fileResp.statusText}\nResponse: ${errorText}`
        );
    }

    const arr = new Uint8Array(await fileResp.arrayBuffer());

    // Detect accidental nested LFS pointers (pointer stored as LFS content). If so, follow once or twice.
    try {
        const maxDepth = options?.maxPointerDepth ?? 5;
        let depth = 0;
        let bytes = arr;
        // Only inspect small prefix as text to avoid heavy decode on large binaries
        while (depth < maxDepth) {
            const previewLength = Math.min(bytes.length, 600);
            const preview = new TextDecoder().decode(bytes.subarray(0, previewLength));
            // Quick check for LFS pointer signature
            if (!/git-lfs\.github\.com\/spec\/v1/.test(preview)) {
                break;
            }
            const oidMatch = preview.match(/\boid\s+sha256:([0-9a-f]{64})\b/i);
            const sizeMatch = preview.match(/\bsize\s+(\d+)\b/);
            if (!oidMatch || !sizeMatch) {
                break;
            }
            const nested = { oid: oidMatch[1], size: Number(sizeMatch[1]) };
            // Fetch the nested target
            bytes = await downloadLFSObject({ headers, url, auth }, nested, {
                maxPointerDepth: 0,
            });
            depth += 1;
        }
        return bytes;
    } catch {
        // If parsing or nested fetch fails, just return original bytes
        return arr;
    }
}

export class GitService {
    private stateManager: StateManager;
    private debugLogging: boolean = false;

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
        // Check VS Code configuration for debug logging setting
        this.debugLogging = vscode.workspace
            .getConfiguration("frontier")
            .get("debugGitLogging", false);
    }

    /**
     * Enable or disable debug logging for git operations
     */
    setDebugLogging(enabled: boolean): void {
        this.debugLogging = enabled;
    }

    /**
     * Conditional debug logging - only logs if debug logging is enabled
     */
    private debugLog(message: string, data?: any): void {
        debugLog(message, data);
    }

    /**
     * Wraps git operations with a timeout to prevent hanging indefinitely
     */
    private async withTimeout<T>(
        operation: Promise<T>,
        timeoutMs: number = 2 * 60 * 1000, // 2 minutes
        operationName: string = "Git operation"
    ): Promise<T> {
        const startTime = Date.now();
        this.debugLog(`[GitService] Starting ${operationName} with ${timeoutMs}ms timeout`);

        const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        try {
            const result = await Promise.race([operation, timeout]);
            const duration = Date.now() - startTime;
            this.debugLog(`[GitService] ${operationName} completed successfully in ${duration}ms`);
            return result as T;
        } catch (error) {
            const duration = Date.now() - startTime;

            if (error instanceof Error && error.message.includes("timed out")) {
                console.error(
                    `[GitService] TIMEOUT: ${operationName} timed out after ${duration}ms`
                );
                console.error(`[GitService] Timeout diagnostic info:`, {
                    operation: operationName,
                    timeoutMs,
                    actualDuration: duration,
                    timestamp: new Date().toISOString(),
                    possibleCauses: [
                        "Network connectivity issues",
                        "Remote server unresponsive",
                        "Firewall/proxy blocking connection",
                        "Large repository data transfer",
                        "Authentication server delays",
                    ],
                });

                // Add network connectivity check
                this.logNetworkDiagnostics();

                throw new Error(
                    `${operationName} failed: Network timeout after ${duration}ms. Please check your connection and try again.`
                );
            }

            // Log other errors with more context
            console.error(`[GitService] ${operationName} failed after ${duration}ms:`, {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                operation: operationName,
                duration,
                timestamp: new Date().toISOString(),
            });

            throw error;
        }
    }

    /**
     * Logs network diagnostic information to help debug connectivity issues
     */
    private async logNetworkDiagnostics(): Promise<void> {
        this.debugLog(`[GitService] Running network diagnostics...`);

        const diagnostics = {
            timestamp: new Date().toISOString(),
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "N/A",
            onlineStatus: typeof navigator !== "undefined" ? (navigator as any).onLine : "Unknown",
            connectionTests: {} as Record<
                string,
                { status: string; responseTime?: number; httpStatus?: number; error?: string }
            >,
        };

        // Test basic connectivity
        const testEndpoints = [
            { name: "GitLab", url: "https://gitlab.com", timeout: 5000 },
            { name: "Frontier API", url: "https://api.frontierrnd.com", timeout: 5000 },
            { name: "Google DNS", url: "https://8.8.8.8", timeout: 3000 },
        ];

        for (const endpoint of testEndpoints) {
            try {
                const startTime = Date.now();
                const response = await Promise.race([
                    fetch(endpoint.url, { method: "HEAD", cache: "no-store" }),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error("timeout")), endpoint.timeout)
                    ),
                ]);
                const duration = Date.now() - startTime;

                diagnostics.connectionTests[endpoint.name] = {
                    status: "success",
                    responseTime: duration,
                    httpStatus: (response as Response).status,
                };
            } catch (error) {
                diagnostics.connectionTests[endpoint.name] = {
                    status: "failed",
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }

        console.error(`[GitService] Network diagnostics:`, diagnostics);
    }

    /**
     * Safe push operation with timeout and retry logic
     */
    private async safePush(
        dir: string,
        auth: { username: string; password: string },
        options?: { force?: boolean; ref?: string; timeoutMs?: number }
    ): Promise<void> {
        const { force = false, ref, timeoutMs = 2 * 60 * 1000 } = options || {};

        this.debugLog(`[GitService] Starting push operation:`, {
            directory: dir,
            ref: ref || "HEAD",
            force,
            timeoutMs,
            timestamp: new Date().toISOString(),
        });

        // Get some context before pushing
        try {
            const currentBranch = await git.currentBranch({ fs, dir });
            const remoteUrl = await this.getRemoteUrl(dir);
            const status = await git.statusMatrix({ fs, dir });
            const changedFiles = status.filter(
                (entry) => entry[1] !== entry[2] || entry[2] !== entry[3]
            ).length;

            this.debugLog(`[GitService] Push context:`, {
                currentBranch,
                remoteUrl,
                changedFiles,
                hasAuth: !!auth.username,
            });
        } catch (contextError) {
            console.warn(`[GitService] Could not gather push context:`, contextError);
        }

        const pushOperation = git.push({
            fs,
            http,
            dir,
            remote: "origin",
            ...(ref && { ref }),
            onAuth: () => {
                this.debugLog(`[GitService] Authentication requested for push operation`);
                return auth;
            },
            ...(force && { force }),
        });

        try {
            await this.withTimeout(pushOperation, timeoutMs, "Push operation");
            this.debugLog(`[GitService] Push completed successfully`);
        } catch (error) {
            console.error(`[GitService] Push operation failed:`, {
                error: error instanceof Error ? error.message : String(error),
                directory: dir,
                ref: ref || "HEAD",
                force,
                timestamp: new Date().toISOString(),
            });
            throw error;
        }
    }

    // Below is a simplified version. It commits if dirty, fetches remote changes, tries pulling (which will error on merge conflicts), and then either pushes or returns a list of files that differ.
    async syncChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string },
        options?: { commitMessage?: string }
    ): Promise<SyncResult> {
        // Check if sync is already in progress
        if (this.stateManager.isSyncLocked()) {
            this.debugLog("Sync already in progress, skipping this request");
            return { hadConflicts: false };
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock(dir);
        if (!lockAcquired) {
            this.debugLog("Failed to acquire sync lock, skipping this request");
            return { hadConflicts: false };
        }

        try {
            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // 1. Commit local changes if needed
            const { isDirty, status: workingCopyStatusBeforeCommit } =
                await this.getWorkingCopyState(dir);
            if (isDirty) {
                this.debugLog("Working copy is dirty, committing local changes (LFS-aware)");
                await this.addAllWithLFS(dir, auth);
                await this.commit(dir, options?.commitMessage || "Local changes", author);
            }

            // 2. Check if we're online
            if (!(await this.isOnline())) {
                return { hadConflicts: false, offline: true };
            }

            // 3. Fetch remote changes to get latest state
            this.debugLog("[GitService] Fetching remote changes");
            try {
                await this.withTimeout(
                    git.fetch({
                        fs,
                        http,
                        dir,
                        onAuth: () => {
                            this.debugLog(
                                "[GitService] Authentication requested for fetch operation"
                            );
                            return auth;
                        },
                    }),
                    2 * 60 * 1000,
                    "Fetch operation"
                );
                this.debugLog("[GitService] Fetch completed successfully");
            } catch (fetchError) {
                console.error("[GitService] Fetch operation failed:", {
                    error: fetchError instanceof Error ? fetchError.message : String(fetchError),
                    directory: dir,
                    hasAuth: !!auth.username,
                    timestamp: new Date().toISOString(),
                });
                throw fetchError;
            }

            // 4. Get references to current state
            const localHead = await git.resolveRef({ fs, dir, ref: "HEAD" });
            let remoteHead;
            const remoteRef = `refs/remotes/origin/${currentBranch}`;

            // 5. Check if remote branch exists
            try {
                remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });
            } catch (err) {
                // Remote branch doesn't exist, just push our changes
                this.debugLog("Remote branch doesn't exist, pushing our changes");
                await this.safePush(dir, auth);
                return { hadConflicts: false };
            }

            // Get files changed in local HEAD (this doesn't need updating after refetch)
            const localStatusMatrix = await git.statusMatrix({ fs, dir });

            this.debugLog("workingCopyStatusBeforeCommit:", workingCopyStatusBeforeCommit);
            this.debugLog("localStatusMatrix:", localStatusMatrix);

            // 6. If local and remote are identical, nothing to do
            if (localHead === remoteHead) {
                this.debugLog("Local and remote are already in sync");
                return { hadConflicts: false };
            }

            // 7. Try fast-forward first (simplest case)
            try {
                this.debugLog("[GitService] Attempting fast-forward merge");
                this.debugLog("[GitService] Fast-forward context:", {
                    localHead: localHead.substring(0, 8),
                    remoteHead: remoteHead.substring(0, 8),
                    currentBranch,
                    directory: dir,
                });

                await this.withTimeout(
                    git.fastForward({
                        fs,
                        http,
                        dir,
                        ref: currentBranch,
                        onAuth: () => {
                            this.debugLog("[GitService] Authentication requested for fast-forward");
                            return auth;
                        },
                    }),
                    2 * 60 * 1000,
                    "Fast-forward operation"
                );

                // Fast-forward worked, push any local changes
                this.debugLog("[GitService] Fast-forward successful, pushing any local changes");
                await this.safePush(dir, auth); // checking here

                // After integrating remote changes, smudge any LFS pointers
                try {
                    await this.smudgeAllLfsPointers(dir, auth);
                } catch (e) {
                    console.warn("[GitService] LFS smudge after fast-forward failed:", e);
                }

                return { hadConflicts: false };
            } catch (err) {
                this.debugLog("[GitService] Fast-forward failed, analyzing conflicts:", {
                    error: err instanceof Error ? err.message : String(err),
                    localHead: localHead.substring(0, 8),
                    remoteHead: remoteHead.substring(0, 8),
                });
            }

            // 8. If we get here, we have divergent histories - check for conflicts
            this.debugLog("Fast-forward failed, need to handle conflicts");

            // Refetch to ensure we have the absolute latest remote state before analyzing conflicts
            this.debugLog("[GitService] Refetching remote changes before conflict analysis");
            try {
                await this.withTimeout(
                    git.fetch({
                        fs,
                        http,
                        dir,
                        onAuth: () => {
                            this.debugLog(
                                "[GitService] Authentication requested for pre-conflict-analysis fetch"
                            );
                            return auth;
                        },
                    }),
                    2 * 60 * 1000,
                    "Pre-conflict-analysis fetch"
                );
                this.debugLog("[GitService] Pre-conflict-analysis fetch completed successfully");

                // After refetch, we might have new LFS pointers in HEAD; smudge them
                try {
                    await this.smudgeAllLfsPointers(dir, auth);
                } catch (e) {
                    console.warn("[GitService] LFS smudge after refetch failed:", e);
                }

                // Update remoteHead reference after the new fetch
                remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });
                this.debugLog(
                    "[GitService] Updated remote HEAD after refetch:",
                    remoteHead.substring(0, 8)
                );
            } catch (fetchError) {
                console.error("[GitService] Pre-conflict-analysis fetch failed:", {
                    error: fetchError instanceof Error ? fetchError.message : String(fetchError),
                    directory: dir,
                    hasAuth: !!auth.username,
                    timestamp: new Date().toISOString(),
                });
                // Continue with conflict analysis using the potentially stale remote state
                console.warn(
                    "[GitService] Continuing with conflict analysis using potentially stale remote state"
                );
            }

            // Recalculate merge base after potential refetch
            const updatedMergeBaseCommits = await git.findMergeBase({
                fs,
                dir,
                oids: [localHead, remoteHead],
            });

            this.debugLog("Updated merge base commits after refetch:", updatedMergeBaseCommits);

            // Update status matrices with potentially new remote state
            const updatedRemoteStatusMatrix = await git.statusMatrix({
                fs,
                dir,
                ref: remoteRef,
            });
            const updatedMergeBaseStatusMatrix =
                updatedMergeBaseCommits.length > 0
                    ? await git.statusMatrix({
                          fs,
                          dir,
                          ref: updatedMergeBaseCommits[0],
                      })
                    : [];

            this.debugLog("updatedRemoteStatusMatrix:", updatedRemoteStatusMatrix);
            this.debugLog("updatedMergeBaseStatusMatrix:", updatedMergeBaseStatusMatrix);

            // Convert status matrices to maps for easier lookup
            const localStatusMap = new Map(
                localStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const remoteStatusMap = new Map(
                updatedRemoteStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const mergeBaseStatusMap = new Map(
                updatedMergeBaseStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );

            // Get all unique filepaths across all three references
            const allFilepaths = new Set([
                ...localStatusMap.keys(),
                ...remoteStatusMap.keys(),
                ...mergeBaseStatusMap.keys(),
            ]);

            // Arrays to store categorized files
            const filesAddedLocally: string[] = [];
            const filesAddedOnRemote: string[] = [];
            const filesDeletedLocally: string[] = [];
            const filesDeletedOnRemote: string[] = [];
            const filesModifiedAndTreatedAsPotentialConflict: string[] = [];

            // Analyze each file's status across all references
            for (const filepath of allFilepaths) {
                const localStatus = localStatusMap.get(filepath);
                const remoteStatus = remoteStatusMap.get(filepath);
                const mergeBaseStatus = mergeBaseStatusMap.get(filepath);

                // File exists in remote but not in local or merge base -> added on remote
                if (
                    remoteStatus &&
                    (remoteStatus as any)[0] === 1 &&
                    (!localStatus || (localStatus as any)[0] === 0) &&
                    (!mergeBaseStatus || (mergeBaseStatus as any)[0] === 0)
                ) {
                    filesAddedOnRemote.push(filepath);
                    continue;
                }

                // File exists in local but not in remote or merge base -> added locally
                if (
                    localStatus &&
                    (localStatus as any)[0] === 1 &&
                    (!remoteStatus || (remoteStatus as any)[0] === 0) &&
                    (!mergeBaseStatus || (mergeBaseStatus as any)[0] === 0)
                ) {
                    filesAddedLocally.push(filepath);
                    continue;
                }

                // File exists in merge base and local but not in remote -> deleted on remote
                if (
                    mergeBaseStatus &&
                    (mergeBaseStatus as any)[0] === 1 &&
                    localStatus &&
                    (localStatus as any)[0] === 1 &&
                    (!remoteStatus || (remoteStatus as any)[0] === 0)
                ) {
                    filesDeletedOnRemote.push(filepath);
                    continue;
                }

                // File exists in merge base and remote but not in local -> deleted locally
                if (
                    mergeBaseStatus &&
                    (mergeBaseStatus as any)[0] === 1 &&
                    remoteStatus &&
                    (remoteStatus as any)[0] === 1 &&
                    (!localStatus || (localStatus as any)[0] === 0)
                ) {
                    filesDeletedLocally.push(filepath);
                    continue;
                }

                // File exists in all three but has different content
                if (
                    localStatus &&
                    (localStatus as any)[0] === 1 &&
                    remoteStatus &&
                    (remoteStatus as any)[0] === 1 &&
                    mergeBaseStatus &&
                    (mergeBaseStatus as any)[0] === 1
                ) {
                    const localModified = (localStatus as any)[1] === 2; // workdir different from HEAD
                    const remoteModified = (remoteStatus as any)[1] === 2; // workdir different from HEAD
                    const mergeBaseModified = (mergeBaseStatus as any)[1] === 2; // merge base different from HEAD

                    // Treat all modified files as potential conflicts for simplicity
                    if (localModified || remoteModified || mergeBaseModified) {
                        filesModifiedAndTreatedAsPotentialConflict.push(filepath);
                    }
                }
            }

            this.debugLog("Files added locally:", filesAddedLocally);
            this.debugLog("Files deleted locally:", filesDeletedLocally);
            this.debugLog("Files added on remote:", filesAddedOnRemote);
            this.debugLog("Files deleted on remote:", filesDeletedOnRemote);
            this.debugLog(
                "Files modified and treated as potential conflict:",
                filesModifiedAndTreatedAsPotentialConflict
            );

            // All changed files for comprehensive conflict detection
            const allChangedFilePaths = [
                ...new Set([
                    ...filesAddedLocally,
                    ...filesModifiedAndTreatedAsPotentialConflict,
                    ...filesDeletedLocally,
                    ...filesAddedOnRemote,
                    ...filesDeletedOnRemote,
                ]),
            ];

            this.debugLog("All changed files:", allChangedFilePaths);

            // 9. Get all files changed in either branch with enhanced conflict detection
            const conflicts = await Promise.all(
                allChangedFilePaths.map(async (filepath) => {
                    let localContent = "";
                    let remoteContent = "";
                    let baseContent = "";
                    let isNew = false;
                    let isDeleted = false;

                    // More precise determination of file status
                    const isAddedLocally = filesAddedLocally.includes(filepath);
                    const isAddedRemotely = filesAddedOnRemote.includes(filepath);
                    const isDeletedLocally = filesDeletedLocally.includes(filepath);
                    const isDeletedRemotely = filesDeletedOnRemote.includes(filepath);

                    // Determine if this is a new file (added on either side)
                    isNew = isAddedLocally || isAddedRemotely;

                    // Determine if this should be considered deleted
                    isDeleted =
                        (isDeletedLocally && !isAddedRemotely) ||
                        (isDeletedRemotely && !isAddedLocally);

                    // Try to read local content if it exists in local HEAD
                    try {
                        if (!isDeletedLocally && !isAddedLocally) {
                            const { blob: lBlob } = await git.readBlob({
                                fs,
                                dir,
                                oid: localHead,
                                filepath,
                            });
                            localContent = new TextDecoder().decode(lBlob);
                        } else if (isAddedLocally) {
                            // For locally added files, read from working directory
                            try {
                                const fileContent = await fs.promises.readFile(
                                    path.join(dir, filepath),
                                    "utf8"
                                );
                                localContent = fileContent;
                            } catch (e) {
                                this.debugLog(`Error reading locally added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in local HEAD`);
                    }

                    // Try to read remote content if it exists in remote HEAD
                    try {
                        if (!isDeletedRemotely && !isAddedRemotely) {
                            const { blob: rBlob } = await git.readBlob({
                                fs,
                                dir,
                                oid: remoteHead,
                                filepath,
                            });
                            remoteContent = new TextDecoder().decode(rBlob);
                        } else if (isAddedRemotely) {
                            try {
                                const { blob: rBlob } = await git.readBlob({
                                    fs,
                                    dir,
                                    oid: remoteHead,
                                    filepath,
                                });
                                remoteContent = new TextDecoder().decode(rBlob);
                            } catch (e) {
                                this.debugLog(`Error reading remotely added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in remote HEAD`);
                    }

                    // Try to read base content if available
                    try {
                        if (updatedMergeBaseCommits.length > 0) {
                            const { blob: bBlob } = await git.readBlob({
                                fs,
                                dir,
                                oid: updatedMergeBaseCommits[0],
                                filepath,
                            });
                            baseContent = new TextDecoder().decode(bBlob);
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in merge base`);
                    }

                    // Special conflict cases handling
                    let isConflict = false;

                    // Case 1: File modified in both branches
                    if (filesModifiedAndTreatedAsPotentialConflict.includes(filepath)) {
                        isConflict = true;
                    }
                    // Case 2: Content differs between branches and at least one differs from base
                    else if (
                        localContent !== remoteContent &&
                        (localContent !== baseContent || remoteContent !== baseContent)
                    ) {
                        isConflict = true;
                    }
                    // Case 3: Added in both branches with different content
                    else if (isAddedLocally && isAddedRemotely && localContent !== remoteContent) {
                        isConflict = true;
                    }
                    // Case 4: Modified locally but deleted remotely
                    else if (
                        !isDeletedLocally &&
                        isDeletedRemotely &&
                        localContent !== baseContent
                    ) {
                        isConflict = true;
                    }
                    // Case 5: Modified remotely but deleted locally
                    else if (
                        isDeletedLocally &&
                        !isDeletedRemotely &&
                        remoteContent !== baseContent
                    ) {
                        isConflict = true;
                    }

                    if (isConflict) {
                        return {
                            filepath,
                            ours: localContent,
                            theirs: remoteContent,
                            base: baseContent,
                            isNew,
                            isDeleted,
                        };
                    }
                    return null;
                })
            ).then((results) =>
                results.filter(
                    (
                        result
                    ): result is {
                        filepath: string;
                        ours: string;
                        theirs: string;
                        base: string;
                        isNew: boolean;
                        isDeleted: boolean;
                    } => result !== null
                )
            );

            this.debugLog(`Found ${conflicts.length} conflicts that need resolution`);
            return { hadConflicts: true, conflicts };
        } catch (err) {
            // Enhanced error logging for sync operations
            console.error(`[GitService] Sync operation failed:`, {
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
                directory: dir,
                author: author.name,
                timestamp: new Date().toISOString(),
            });

            // Log additional context that might help with debugging
            try {
                const currentBranch = await git.currentBranch({ fs, dir });
                const remoteUrl = await this.getRemoteUrl(dir);
                const status = await git.statusMatrix({ fs, dir });

                console.error(`[GitService] Sync failure context:`, {
                    currentBranch,
                    remoteUrl,
                    statusMatrixSize: status.length,
                    dirtyFiles: status.filter(
                        (entry) => entry[1] !== entry[2] || entry[2] !== entry[3]
                    ).length,
                });
            } catch (contextError) {
                console.warn(`[GitService] Could not gather sync failure context:`, contextError);
            }

            throw err;
        } finally {
            // Always release the lock when done, regardless of success or failure
            await this.stateManager.releaseSyncLock();
        }
    }

    /**
     * Helper functions to identify file status from git status matrix
     * Each entry in status matrix is [filepath, head, workdir, stage]
     * - head: file exists in HEAD commit (1) or not (0)
     * - workdir: file is absent (0), identical to HEAD (1), or different from HEAD (2)
     * - stage: file is absent (0), identical to HEAD (1), identical to WORKDIR (2), or different from WORKDIR (3)
     */
    private fileStatus = {
        isNew: ([_, head, workdir]: [string, number, number, number]): boolean =>
            head === 0 && workdir === 1,

        isModified: ([_, head, workdir, stage]: [string, number, number, number]): boolean =>
            (head === 1 && workdir === 2) || // Modified compared to HEAD
            (head === 1 && workdir === 1 && workdir !== stage), // Same as HEAD but different in stage

        isDeleted: ([_, head, workdir]: [string, number, number, number]): boolean =>
            head === 1 && workdir === 0,

        hasStageChanges: ([_, head, _workdir, stage]: [string, number, number, number]): boolean =>
            stage !== head,

        hasWorkdirChanges: ([_, head, workdir]: [string, number, number, number]): boolean =>
            workdir !== head,

        isAnyChange: ([_, head, workdir, stage]: [string, number, number, number]): boolean =>
            this.fileStatus.isNew([_, head, workdir, stage]) ||
            this.fileStatus.isModified([_, head, workdir, stage]) ||
            this.fileStatus.isDeleted([_, head, workdir, stage]) ||
            this.fileStatus.hasStageChanges([_, head, workdir, stage]) ||
            this.fileStatus.hasWorkdirChanges([_, head, workdir, stage]),
    };

    /**
     * Check if the working copy has any changes
     */
    private async getWorkingCopyState(dir: string): Promise<{ isDirty: boolean; status: any[] }> {
        const status = await git.statusMatrix({ fs, dir });
        this.debugLog(
            "Status before committing local changes:",
            JSON.stringify(
                status.filter(
                    (entry) => entry.includes(0) || entry.includes(2) || entry.includes(3)
                )
            )
        );

        // Apply LFS-aware cleanliness: treat LFS-tracked files as clean if the
        // worktree bytes hash to the same LFS pointer {oid,size} as HEAD.
        const lfsAwareChanges: Array<[string, number, number, number]> = [];

        for (const entry of status) {
            const [filepath, head, workdir, stage] = entry as [string, number, number, number];

            // If there are no changes at all, preserve as-is
            if (!this.fileStatus.isAnyChange(entry)) {
                continue;
            }

            // Only consider LFS override when it's a modification (not new/deleted) and
            // the difference is specifically in the workdir vs HEAD content.
            const isPotentialLfsCleanCase =
                head === 1 && // exists in HEAD
                workdir !== head && // workdir differs from HEAD
                !this.fileStatus.isNew(entry) &&
                !this.fileStatus.isDeleted(entry);

            if (
                isPotentialLfsCleanCase &&
                (await this.isLfsWorktreeEquivalentToHeadPointer(dir, filepath))
            ) {
                // Skip adding to changes: treat as clean in the working tree
                continue;
            }

            lfsAwareChanges.push(entry);
        }

        const isDirty = lfsAwareChanges.some((entry) => this.fileStatus.isAnyChange(entry));
        return { isDirty, status };
    }

    /**
     * Complete a merge after conflicts have been resolved
     */
    async completeMerge(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string },
        resolvedFiles: Array<{
            filepath: string;
            resolution: "deleted" | "created" | "modified";
        }>
    ): Promise<void> {
        // Check if sync is already in progress
        if (this.stateManager.isSyncLocked()) {
            this.debugLog("Sync already in progress, cannot complete merge");
            throw new Error("Sync operation already in progress. Please try again later.");
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock(dir);
        if (!lockAcquired) {
            this.debugLog("Failed to acquire sync lock, cannot complete merge");
            throw new Error("Failed to acquire sync lock. Please try again later.");
        }

        try {
            this.debugLog(
                "=== Starting completeMerge because client called and passed resolved files ==="
            );
            this.debugLog(`Resolved files: ${resolvedFiles.map((f) => f.filepath).join(", ")}`);

            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // Stage the resolved files based on their resolution type (LFS-aware)
            for (const { filepath, resolution } of resolvedFiles) {
                this.debugLog(
                    `Processing resolved file: ${filepath} with resolution: ${resolution}`
                );

                if (resolution === "deleted") {
                    this.debugLog(`Removing file from git: ${filepath}`);
                    await git.remove({ fs, dir, filepath });
                } else {
                    // LFS-aware add: smudge if pointer in HEAD; else add via LFS if tracked; else regular add
                    this.debugLog(`Adding file to git (LFS-aware): ${filepath}`);
                    await this.stageResolvedFileWithLFS(dir, filepath, auth);
                }
            }

            // Get the current state before creating the merge commit
            const localHead = await git.resolveRef({ fs, dir, ref: currentBranch });
            const remoteRef = this.getRemoteRef(currentBranch);
            const remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });

            // Fetch latest changes to ensure we have the most recent remote state
            this.debugLog("[GitService] Fetching latest changes before merge completion");
            await this.withTimeout(
                git.fetch({
                    fs,
                    http,
                    dir,
                    onAuth: () => {
                        this.debugLog("[GitService] Authentication requested for pre-merge fetch");
                        return auth;
                    },
                }),
                2 * 60 * 1000,
                "Pre-merge fetch operation"
            );
            const commitMessage = `Merge branch 'origin/${currentBranch}'`;
            this.debugLog(`Creating merge commit with message: ${commitMessage}`);

            try {
                // Create a merge commit with the two parents
                await git.commit({
                    fs,
                    dir,
                    message: commitMessage,
                    author: {
                        name: author.name,
                        email: author.email,
                        timestamp: Math.floor(Date.now() / 1000),
                        timezoneOffset: new Date().getTimezoneOffset(),
                    },
                    parent: [localHead, remoteHead],
                });
            } catch (commitError) {
                console.error("Error creating merge commit:", commitError);

                // Create a regular commit instead
                this.debugLog("Attempting to create a regular commit with the resolved changes");
                await git.commit({
                    fs,
                    dir,
                    message: `Resolved conflicts with ${this.getShortRemoteRef(currentBranch)}`,
                    author: {
                        name: author.name,
                        email: author.email,
                        timestamp: Math.floor(Date.now() / 1000),
                        timezoneOffset: new Date().getTimezoneOffset(),
                    },
                });
            }

            // Push the merge commit with a more robust approach
            this.debugLog("Pushing merge commit");
            try {
                // Try normal push first
                await this.safePush(dir, auth, { ref: currentBranch });
                this.debugLog("Successfully pushed merge commit");

                // After successful merge and push, check for newly created files that might be LFS pointers
                this.debugLog("Checking for newly created LFS pointer files after merge");
                await this.smudgeNewLfsPointersAfterMerge(dir, resolvedFiles, auth);
            } catch (pushError) {
                console.error("Error pushing merge commit:", pushError);
                throw new Error(
                    `Failed to push merge commit: ${pushError instanceof Error ? pushError.message : String(pushError)}`
                );
            }

            this.debugLog("=== completeMerge completed successfully ===");
        } catch (error) {
            console.error("Complete merge error:", error);
            throw new Error(
                `Complete merge operation failed: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            // Always release the lock when done, regardless of success or failure
            await this.stateManager.releaseSyncLock();
        }
    }

    /**
     * Stage all changes in the working directory
     */
    async addAll(dir: string): Promise<void> {
        const status = await git.statusMatrix({ fs, dir });

        // Handle deletions
        const deletedFiles = status
            .filter((entry) => this.fileStatus.isDeleted(entry))
            .map(([filepath]) => filepath);

        for (const filepath of deletedFiles) {
            await git.remove({ fs, dir, filepath });
        }

        // Handle modifications and additions
        const modifiedFiles = status
            .filter(
                (entry) =>
                    this.fileStatus.isNew(entry) ||
                    (this.fileStatus.hasWorkdirChanges(entry) && !this.fileStatus.isDeleted(entry))
            )
            .map(([filepath]) => filepath);

        for (const filepath of modifiedFiles) {
            await git.add({ fs, dir, filepath });
        }
    }

    /**
     * Stage all changes, routing LFS-tracked files through LFS upload.
     * This preserves the working tree's original binary content after staging.
     */
    async addAllWithLFS(dir: string, auth: { username: string; password: string }): Promise<void> {
        const status = await git.statusMatrix({ fs, dir });

        // Handle deletions
        const deletedFiles = status
            .filter((entry) => this.fileStatus.isDeleted(entry))
            .map(([filepath]) => filepath);

        for (const filepath of deletedFiles) {
            await git.remove({ fs, dir, filepath });
        }

        // Handle modifications and additions
        const modifiedFiles = status
            .filter(
                (entry) =>
                    this.fileStatus.isNew(entry) ||
                    (this.fileStatus.hasWorkdirChanges(entry) && !this.fileStatus.isDeleted(entry))
            )
            .map(([filepath]) => filepath);

        for (const filepath of modifiedFiles) {
            // If LFS-tracked and worktree bytes correspond to the same LFS pointer as HEAD,
            // the file only appears modified due to smudging. Skip re-adding and re-uploading.
            if (await this.isLfsTracked(dir, filepath)) {
                if (await this.isLfsWorktreeEquivalentToHeadPointer(dir, filepath)) {
                    continue;
                }
                await this.addWithLFS(dir, filepath, auth);
                continue;
            }

            // Non-LFS files: regular add
            await git.add({ fs, dir, filepath });
        }
    }

    /**
     * Create a commit with the given message
     */
    async commit(
        dir: string,
        message: string,
        author: { name: string; email: string }
    ): Promise<string> {
        return git.commit({
            fs,
            dir,
            message,
            author: {
                name: author.name,
                email: author.email,
                timestamp: Math.floor(Date.now() / 1000),
                timezoneOffset: new Date().getTimezoneOffset(),
            },
        });
    }

    // ========== UTILITY METHODS ==========

    async clone(
        url: string,
        dir: string,
        auth?: { username: string; password: string }
    ): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Cloning repository...",
                cancellable: false,
            },
            async (progress) => {
                try {
                    // Ensure the directory exists
                    const dirUri = vscode.Uri.file(dir);
                    await vscode.workspace.fs.createDirectory(dirUri);

                    await git.clone({
                        fs,
                        http,
                        dir,
                        url,
                        onProgress: (event) => {
                            if (event.phase === "Receiving objects") {
                                progress.report({
                                    message: `${event.phase}: ${event.loaded}/${event.total} objects`,
                                    increment: (event.loaded / event.total) * 100,
                                });
                            }
                        },
                        ...(auth && {
                            onAuth: () => auth,
                        }),
                    });
                } catch (error) {
                    console.error("Clone error:", error);
                    throw new Error(
                        `Failed to clone repository: ${error instanceof Error ? error.message : "Unknown error"}`
                    );
                }
            }
        );

        // After clone, attempt to smudge LFS pointers in the working tree
        try {
            if (auth) {
                await this.smudgeAllLfsPointers(dir, auth);
            }
        } catch (e) {
            console.warn("[GitService] LFS smudge after clone failed:", e);
        }
    }

    async add(dir: string, filepath: string): Promise<void> {
        await git.add({ fs, dir, filepath });
    }

    async init(dir: string): Promise<void> {
        try {
            await git.init({ fs, dir, defaultBranch: "main" });
            await git.branch({ fs, dir, ref: "main", checkout: true });
        } catch (error) {
            console.error("Init error:", error);
            throw new Error(
                `Failed to initialize repository: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    async getRemoteUrl(dir: string): Promise<string | undefined> {
        try {
            const remotes = await git.listRemotes({ fs, dir });
            const origin = remotes.find((remote) => remote.remote === "origin");
            return origin?.url;
            // const sanitizedUrl = this.stripCredentialsFromUrl(origin?.url || "");
            // return sanitizedUrl;
        } catch (error) {
            console.error("Error getting remote URL:", error);
            return undefined;
        }
    }

    async getRemotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
        return git.listRemotes({ fs, dir });
    }

    async addRemote(dir: string, name: string, url: string): Promise<void> {
        try {
            await git.addRemote({ fs, dir, remote: name, url });
        } catch (error) {
            // If remote already exists, update it
            if (error instanceof Error && error.message.includes("already exists")) {
                await git.deleteRemote({ fs, dir, remote: name });
                await git.addRemote({ fs, dir, remote: name, url });
            } else {
                throw error;
            }
        }
    }

    async hasGitRepository(dir: string): Promise<boolean> {
        try {
            await git.resolveRef({ fs, dir, ref: "HEAD" });
            return true;
        } catch (error) {
            return false;
        }
    }

    async configureAuthor(dir: string, name: string, email: string): Promise<void> {
        await this.setConfig(dir, "user.name", name);
        await this.setConfig(dir, "user.email", email);
    }

    async setConfig(dir: string, path: string, value: string): Promise<void> {
        await git.setConfig({ fs, dir, path, value });
    }

    async push(
        dir: string,
        auth: { username: string; password: string },
        options?: { force?: boolean }
    ): Promise<void> {
        await this.safePush(dir, auth, { force: options?.force });
    }

    /**
     * Find files whose HEAD blob is an LFS pointer, ensure worktree contains real bytes.
     * Called after clone and after we integrate remote updates.
     */
    private async smudgeAllLfsPointers(
        dir: string,
        auth: { username: string; password: string }
    ): Promise<void> {
        const status = await git.statusMatrix({ fs, dir });

        // Determine LFS base URL and auth
        const remoteUrl = await this.getRemoteUrl(dir);
        if (!remoteUrl) {
            return;
        }
        const { cleanUrl, auth: embedded } = GitService.parseGitUrl(remoteUrl);
        const effectiveAuth = embedded ?? auth;
        const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;

        for (const [filepath] of status) {
            // Read HEAD blob and see if it is an LFS pointer; smudge if so (even if .gitattributes is missing)
            const headPointer = await this.readHeadPointerInfo(dir, filepath);
            if (!headPointer) {
                continue;
            }

            // Check worktree content; if it already equals the binary for pointer, skip.
            // We conservatively download if the worktree isn't a valid pointer placeholder.
            try {
                const abs = path.join(dir, filepath);
                const content = await fs.promises.readFile(abs);
                const text = content.toString("utf8");
                const parsed = this.parseLfsPointer(text);
                if (!parsed) {
                    // Not a pointer text in worktree; assume already smudged.
                    continue;
                }
            } catch {
                // If cannot read, continue to attempt download
            }

            try {
                const bytes = await downloadLFSObject(
                    { url: lfsBaseUrl, headers: {}, auth: effectiveAuth },
                    { oid: headPointer.oid, size: headPointer.size }
                );
                const abs = path.join(dir, filepath);
                await fs.promises.writeFile(abs, bytes);
            } catch (err) {
                console.warn(`[GitService] Failed to download LFS object for ${filepath}:`, err);
            }
        }
    }

    /**
     * Force re-download of all LFS-managed files in the current worktree.
     * For every file whose HEAD blob is a valid LFS pointer:
     *  - restore the pointer content into the worktree (discard local blob changes for that file only)
     *  - download the real bytes from LFS and overwrite the pointer content in the worktree
     * Does not stage or commit anything; index remains with pointer content.
     */
    async redownloadAllLfsInWorktree(
        dir: string,
        auth: { username: string; password: string }
    ): Promise<{ processed: number; errors: Array<{ filepath: string; error: string }> }> {
        this.debugLog(
            `[GitService][redownload] Starting redownload of all LFS files in worktree: ${dir}`
        );
        const status = await git.statusMatrix({ fs, dir });
        this.debugLog(`[GitService][redownload] Found ${status.length} files in status matrix`);

        const remoteUrl = await this.getRemoteUrl(dir);
        if (!remoteUrl) {
            console.error(
                `[GitService][redownload] No remote URL configured for repository: ${dir}`
            );
            return {
                processed: 0,
                errors: [{ filepath: "<all>", error: "No remote URL configured" }],
            };
        }
        const { cleanUrl, auth: embedded } = GitService.parseGitUrl(remoteUrl);
        const effectiveAuth = embedded ?? auth;
        const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;
        this.debugLog(`[GitService][redownload] Using LFS base URL: ${lfsBaseUrl}`);

        let processed = 0;
        const errors: Array<{ filepath: string; error: string }> = [];

        const headOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
        this.debugLog(`[GitService][redownload] HEAD OID: ${headOid}`);

        for (const [filepath] of status) {
            try {
                // Read HEAD blob; if it's not a pointer, skip.
                let blob: Uint8Array | undefined;
                try {
                    const { blob: b } = await git.readBlob({ fs, dir, oid: headOid, filepath });
                    blob = b;
                } catch {
                    console.debug(
                        `[GitService][redownload] Could not read blob for ${filepath}, skipping`
                    );
                    continue;
                }
                const text = new TextDecoder().decode(blob);
                const pointer = this.parseLfsPointer(text);
                if (!pointer) {
                    // console.debug(`[GitService][redownload] ${filepath} is not an LFS pointer, skipping`);
                    continue;
                }
                this.debugLog(`[GitService][redownload]text ${filepath} text: ${text}`);

                this.debugLog(
                    `[GitService][redownload] Processing LFS file: ${filepath} (OID: ${pointer.oid}, Size: ${pointer.size})`
                );

                const abs = path.join(dir, filepath);
                // 1) Restore pointer content to worktree (discard local blob for this file)
                // await fs.promises.writeFile(abs, Buffer.from(blob));
                console.debug(
                    `[GitService][redownload] Restored pointer content to worktree for ${filepath}`
                );

                // 2) Download real content and overwrite worktree
                const bytes = await downloadLFSObject(
                    { url: lfsBaseUrl, headers: {}, auth: effectiveAuth },
                    { oid: pointer.oid, size: pointer.size }
                );
                const downloadedFile = new TextDecoder().decode(bytes);
                this.debugLog(`[GitService][redownload] downloaded: ${downloadedFile}`);
                await fs.promises.writeFile(abs, bytes);
                this.debugLog(
                    `[GitService][redownload] Successfully downloaded and wrote LFS object for ${filepath} (${bytes.length} bytes)`
                );

                processed += 1;
            } catch (e: any) {
                const errorMsg = e?.message ?? String(e);
                console.error(
                    `[GitService][redownload] Failed to process LFS file ${filepath}:`,
                    errorMsg
                );
                errors.push({ filepath, error: errorMsg });
            }
        }

        this.debugLog(
            `[GitService][redownload] Completed LFS redownload: processed ${processed} files, ${errors.length} errors`
        );
        return { processed, errors };
    }

    /** Check newly created/modified files after merge for LFS pointers and smudge them */
    private async smudgeNewLfsPointersAfterMerge(
        dir: string,
        resolvedFiles: Array<{ filepath: string; resolution: "deleted" | "created" | "modified" }>,
        auth: { username: string; password: string }
    ): Promise<void> {
        const remoteUrl = await this.getRemoteUrl(dir);
        if (!remoteUrl) {
            return;
        }
        const { cleanUrl, auth: embedded } = GitService.parseGitUrl(remoteUrl);
        const effectiveAuth = embedded ?? auth;
        const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;

        for (const { filepath, resolution } of resolvedFiles) {
            // Only process newly created or modified files
            if (resolution === "deleted") {
                continue;
            }

            try {
                // Check if this file should be tracked by LFS
                if (!(await this.isLfsTracked(dir, filepath))) {
                    continue;
                }

                const abs = path.join(dir, filepath);
                const content = await fs.promises.readFile(abs, "utf8");
                const pointer = this.parseLfsPointer(content);

                if (!pointer) {
                    // Not a pointer file, skip
                    continue;
                }

                this.debugLog(
                    `[GitService] Found LFS pointer in newly created/modified file: ${filepath}`
                );
                this.debugLog(
                    `[GitService] Downloading LFS object: ${pointer.oid} (${pointer.size} bytes)`
                );

                // Download the real content and replace the pointer
                const bytes = await downloadLFSObject(
                    { url: lfsBaseUrl, headers: {}, auth: effectiveAuth },
                    { oid: pointer.oid, size: pointer.size }
                );

                await fs.promises.writeFile(abs, bytes);
                this.debugLog(
                    `[GitService] Successfully replaced pointer with LFS content for ${filepath}`
                );
            } catch (err) {
                console.warn(
                    `[GitService] Failed to process potential LFS pointer file ${filepath}:`,
                    err
                );
            }
        }
    }

    /** Smudge a single file if the HEAD blob is an LFS pointer: download real bytes and write to worktree */
    private async smudgeSingleLfsPointer(
        dir: string,
        filepath: string,
        auth: { username: string; password: string }
    ): Promise<void> {
        const remoteUrl = await this.getRemoteUrl(dir);
        if (!remoteUrl) {
            return;
        }
        const { cleanUrl, auth: embedded } = GitService.parseGitUrl(remoteUrl);
        const effectiveAuth = embedded ?? auth;
        const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;

        const headPointer = await this.readHeadPointerInfo(dir, filepath);
        if (!headPointer) {
            return;
        }

        try {
            const bytes = await downloadLFSObject(
                { url: lfsBaseUrl, headers: {}, auth: effectiveAuth },
                { oid: headPointer.oid, size: headPointer.size }
            );
            const abs = path.join(dir, filepath);
            await fs.promises.writeFile(abs, bytes);
        } catch (err) {
            console.warn(`[GitService] Failed to smudge LFS object for ${filepath}:`, err);
        }
    }

    /** Stage a resolved file in an LFS-aware way for merge completion */
    private async stageResolvedFileWithLFS(
        dir: string,
        filepath: string,
        auth: { username: string; password: string }
    ): Promise<void> {
        // If HEAD blob is a pointer, smudge to ensure real bytes in worktree, keep pointer in index/history
        const headPointer = await this.readHeadPointerInfo(dir, filepath);
        if (headPointer) {
            await this.smudgeSingleLfsPointer(dir, filepath, auth);
            return;
        }

        // Otherwise, if file should be tracked by LFS, add via LFS to stage pointer and keep real bytes in worktree
        if (await this.isLfsTracked(dir, filepath)) {
            await this.addWithLFS(dir, filepath, auth);
            return;
        }

        // Fallback: regular add
        await git.add({ fs, dir, filepath });
    }

    async isOnline(): Promise<boolean> {
        try {
            // Check internet connectivity by making HEAD requests and checking response codes
            const userIsOnline = await fetch("https://gitlab.com", {
                method: "HEAD",
                cache: "no-store", // Prevent caching
            })
                .then((res) => (res as Response).status === 200)
                .catch(() => false);

            const apiIsOnline = await fetch("https://api.frontierrnd.com")
                .then((res) => {
                    this.debugLog("apiIsOnline", { res });
                    return (res as Response).status === 200;
                })
                .catch(() => false);

            if (!userIsOnline) {
                vscode.window.showWarningMessage(
                    "You are offline. Please connect to the internet to sync changes."
                );
            }
            if (!apiIsOnline) {
                vscode.window.showWarningMessage(
                    "The API is offline. Please try again later. Your local changes are saved, and will sync to the cloud when the API is back online."
                );
            }
            return userIsOnline && apiIsOnline;
        } catch (error) {
            return false;
        }
    }

    /**
     * Helper method to get the short reference to a remote branch
     * @param branch The branch name
     * @returns The short reference to the remote branch
     */
    private getShortRemoteRef(branch: string): string {
        return `origin/${branch}`;
    }

    /**
     * Helper method to get the full reference to a remote branch
     * @param branch The branch name
     * @returns The full reference to the remote branch
     */
    private getRemoteRef(branch: string): string {
        return `refs/remotes/origin/${branch}`;
    }

    /**
     * Parse .gitattributes and return globs that have filter=lfs
     */
    private async getLfsGlobs(dir: string): Promise<string[]> {
        try {
            const attrsPath = path.join(dir, ".gitattributes");
            const text = await fs.promises.readFile(attrsPath, "utf8");
            const globs: string[] = [];

            for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line || line.startsWith("#")) {
                    continue;
                }

                // naive split: "<pattern> attr[=val] attr[=val] ..."
                const [pattern, ...attrs] = line.split(/\s+/);
                if (!pattern) {
                    continue;
                }

                // explicitly contain "filter=lfs"
                const hasLfs = attrs.some((a) => /^filter\s*=\s*lfs$/i.test(a));
                if (hasLfs) {
                    globs.push(pattern);
                }
            }
            return globs;
        } catch {
            // No .gitattributes is fine
            return [];
        }
    }

    /**
     * Very small glob -> RegExp converter supporting "*", "?", and "**"
     */
    private globToRegExp(glob: string): RegExp {
        // Escape regex specials except *, ?, which we'll handle separately
        let s = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");

        // Handle ** first (multi-segment match including path separators)
        s = s.replace(/\*\*/g, "§DOUBLESTAR§");

        // Handle remaining single * (match anything except path separator)
        s = s.replace(/\*/g, "[^/]*");

        // Handle ? (match single char except path separator)
        s = s.replace(/\?/g, "[^/]");

        // Restore ** replacement
        s = s.replace(/§DOUBLESTAR§/g, ".*");

        return new RegExp("^" + s + "$");
    }

    private async isLfsTracked(dir: string, filepath: string): Promise<boolean> {
        const globs = await this.getLfsGlobs(dir);
        // console.log(`[GitService] ${filepath} is LFS-tracked: ${globs.length > 0}`);
        // console.log(`[GitService] ${filepath} globs: ${globs}`);
        if (globs.length === 0) {
            return false;
        }

        // Normalize to forward slashes relative to repo root
        const rel = filepath.replace(/\\/g, "/");
        // console.log(`[GitService] ${filepath} rel: ${rel}`);
        for (const g of globs) {
            const re = this.globToRegExp(g);
            // console.log(`[GitService] ${filepath} re: ${re}`);
            // If the pattern contains a path separator, test against the full relative path.
            // Otherwise, test against the basename so patterns like "*.webm" match in any folder.
            const subject = g.includes("/") ? rel : path.posix.basename(rel);
            if (re.test(subject)) {
                // console.log(`[GitService] ${filepath} re.test(rel) true`);
                return true;
            }
        }
        this.debugLog(`[GitService] ${filepath} re.test(rel) false`);
        return false;
    }

    /** Parse LFS pointer text into { oid, size } */
    private parseLfsPointer(pointerText: string): { oid: string; size: number } | null {
        try {
            // Strip possible UTF-8 BOM and normalize
            if (pointerText && pointerText.charCodeAt(0) === 0xfeff) {
                pointerText = pointerText.slice(1);
            }
            const lines = pointerText
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            const text = lines.join("\n");
            // Be permissive: require only oid and size; version line can vary
            const oidMatch = text.match(/\boid\s+sha256:([0-9a-f]{64})\b/i);
            const sizeMatch = text.match(/\bsize\s+(\d+)\b/);
            if (!oidMatch || !sizeMatch) {
                return null;
            }
            return { oid: oidMatch[1], size: Number(sizeMatch[1]) };
        } catch {
            return null;
        }
    }

    /** Compute { oid, size } for current worktree bytes using LFS pointer algorithm */
    private async buildWorktreePointerInfo(
        dir: string,
        filepath: string
    ): Promise<{ oid: string; size: number } | null> {
        try {
            const absPath = path.join(dir, filepath);
            const bytes = await fs.promises.readFile(absPath);
            const buildPointerInfo = (lfs as any).buildPointerInfo;
            if (!buildPointerInfo) {
                return null;
            }
            const info = await buildPointerInfo(bytes);
            const oid = String((info as any).oid ?? "");
            const size = Number((info as any).size ?? 0);
            if (!oid) {
                return null;
            }
            return { oid, size };
        } catch {
            return null;
        }
    }

    /** Read pointer from HEAD for a file, if the HEAD blob is a valid LFS pointer */
    private async readHeadPointerInfo(
        dir: string,
        filepath: string
    ): Promise<{ oid: string; size: number } | null> {
        try {
            const headOid = await git.resolveRef({ fs, dir, ref: "HEAD" });
            const { blob } = await git.readBlob({ fs, dir, oid: headOid, filepath });
            const text = new TextDecoder().decode(blob);
            return this.parseLfsPointer(text);
        } catch {
            return null;
        }
    }

    /** Determine if LFS-tracked file's worktree bytes match the HEAD pointer */
    private async isLfsWorktreeEquivalentToHeadPointer(
        dir: string,
        filepath: string
    ): Promise<boolean> {
        // Must be LFS-tracked, otherwise this equivalence does not apply
        if (!(await this.isLfsTracked(dir, filepath))) {
            return false;
        }

        const worktreePointer = await this.buildWorktreePointerInfo(dir, filepath);
        if (!worktreePointer) {
            return false;
        }

        const headPointer = await this.readHeadPointerInfo(dir, filepath);
        if (!headPointer) {
            return false;
        }

        const equal =
            headPointer.oid === worktreePointer.oid && headPointer.size === worktreePointer.size;
        if (!equal) {
            this.debugLog("LFS pointer mismatch:", {
                filepath,
                headPointer,
                worktreePointer,
            });
        }
        return equal;
    }

    /**
     * Upload a file to LFS and get pointer info
     */

    private static parseGitUrl(url: string): {
        cleanUrl: string;
        auth?: { username: string; password: string };
    } {
        try {
            const urlObj = new URL(url);

            // Check if URL has embedded credentials
            if (urlObj.username || urlObj.password) {
                const auth = {
                    username: decodeURIComponent(urlObj.username),
                    password: decodeURIComponent(urlObj.password),
                };

                // Remove credentials from URL
                urlObj.username = "";
                urlObj.password = "";

                return { cleanUrl: urlObj.toString(), auth };
            }

            return { cleanUrl: url };
        } catch (error) {
            // If URL parsing fails, return as-is
            console.warn("[LFS] Could not parse URL, using as-is:", error);
            return { cleanUrl: url };
        }
    }

    /**
     * For a given path: if tracked by LFS, upload to LFS, stage pointer,
     * then restore the original content in the working tree so the user can keep working.
     */
    private async addWithLFS(
        dir: string,
        filepath: string,
        authFromCaller?: { username: string; password: string }
    ): Promise<void> {
        // If not LFS-tracked, do normal add
        if (!(await this.isLfsTracked(dir, filepath))) {
            this.debugLog(`[GitService] ${filepath} is not LFS-tracked; adding as normal`);
            await git.add({ fs, dir, filepath });
            return;
        }
        this.debugLog(`[GitService] ${filepath} is LFS-tracked; adding as LFS`);
        // Read original bytes
        const abs = path.join(dir, filepath);
        const buf = await fs.promises.readFile(abs);

        // Resolve remote URL
        const remoteUrl = await this.getRemoteUrl(dir);
        if (!remoteUrl) {
            // Fall back: just add as normal if we have no remote yet
            console.warn(`[GitService] No remote URL; adding ${filepath} without LFS`);
            await git.add({ fs, dir, filepath });
            return;
        }
        const { cleanUrl, auth } = GitService.parseGitUrl(remoteUrl);
        // Prefer embedded auth if present; otherwise use the caller-provided auth (e.g. oauth2 + token)
        const effectiveAuth = auth ?? authFromCaller;

        // Ensure repo URL includes .git to hit correct LFS endpoints on some servers
        const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;

        this.debugLog(`[GitService] LFS base URL: ${lfsBaseUrl}`);
        this.debugLog(
            `[GitService] Using ${auth ? "embedded" : authFromCaller ? "provided" : "no"} auth for LFS`
        );

        if (!effectiveAuth) {
            console.warn(`[GitService] No auth; adding ${filepath} without LFS`);
            await git.add({ fs, dir, filepath });
            return;
        }
        // Check if HEAD already has this file as an LFS pointer with the same content
        const headPointer = await this.readHeadPointerInfo(dir, filepath);
        const currentPointer = await this.buildWorktreePointerInfo(dir, filepath);

        if (
            headPointer &&
            currentPointer &&
            headPointer.oid === currentPointer.oid &&
            headPointer.size === currentPointer.size
        ) {
            this.debugLog(
                `[GitService] File ${filepath} already in LFS with same content, skipping upload`
            );
            // Just stage the existing pointer without re-uploading
            const existingPointerBlob = lfs.formatPointerInfo(headPointer);
            await fs.promises.writeFile(abs, Buffer.from(existingPointerBlob));
            await git.add({ fs, dir, filepath });
            await fs.promises.writeFile(abs, buf); // Restore original bytes
            return;
        }

        // Upload to LFS via our helper (handles batch, upload, verify and x-http-method)
        this.debugLog(`[GitService] Uploading ${filepath} to LFS`);
        const pointerInfos = await uploadBlobsToLFSBucket(
            {
                url: lfsBaseUrl,
                headers: {},
                auth: effectiveAuth, // Pass credentials (embedded or provided)
            },
            [buf]
        );
        const pointerBlob = lfs.formatPointerInfo(pointerInfos[0]);

        // Write pointer, stage it, then restore original bytes locally
        await fs.promises.writeFile(abs, Buffer.from(pointerBlob));
        await git.add({ fs, dir, filepath });
        await fs.promises.writeFile(abs, buf);
    }
}
