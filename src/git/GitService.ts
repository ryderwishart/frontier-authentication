import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import * as fs from "fs";
import * as vscode from "vscode";
import * as path from "path";

import { StateManager } from "../state";

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
}

export enum RemoteBranchStatus {
    FOUND,
    NOT_FOUND,
    ERROR,
}

// LFS-related interfaces
export interface LFSPointer {
    version: string;
    oid: string;
    size: number;
}

export interface LFSBatchRequest {
    operation: "download" | "upload";
    objects: Array<{
        oid: string;
        size: number;
    }>;
}

export interface LFSBatchResponse {
    objects: Array<{
        oid: string;
        size: number;
        authenticated: boolean;
        actions?: {
            download?: {
                href: string;
                header?: Record<string, string>;
            };
            upload?: {
                href: string;
                header?: Record<string, string>;
            };
        };
        error?: {
            code: number;
            message: string;
        };
    }>;
}

export class GitService {
    private stateManager: StateManager;
    private debugLogging: boolean = false;

    // LFS Configuration
    private static readonly LFS_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB in bytes
    private static readonly LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
    private static readonly LFS_CACHE_KEY = "lfs_objects";

    // LFS tracking patterns for multimedia and large files
    private static readonly LFS_TRACKING_PATTERNS = [
        // Video files
        "*.mp4",
        "*.mov",
        "*.avi",
        "*.mkv",
        "*.webm",
        "*.flv",
        "*.wmv",
        // Audio files
        "*.mp3",
        "*.wav",
        "*.flac",
        "*.m4a",
        "*.ogg",
        "*.aac",
        // Images (large formats)
        "*.tiff",
        "*.tif",
        "*.bmp",
        "*.raw",
        "*.psd",
        "*.ai",
        // Design files
        "*.sketch",
        "*.fig",
        "*.xd",
        // Archive files
        "*.zip",
        "*.tar.gz",
        "*.rar",
        "*.7z",
        // Large document files
        "*.pdf",
    ];

    constructor(stateManager: StateManager) {
        this.stateManager = stateManager;
        // Check VS Code configuration for debug logging setting
        this.debugLogging = vscode.workspace
            .getConfiguration("frontier")
            .get("debugGitLogging", false);
    }

    /**
     * Check if content is an LFS pointer file
     */
    private isLFSPointer(content: Uint8Array): boolean {
        try {
            const text = new TextDecoder().decode(content);
            return text.startsWith(GitService.LFS_POINTER_PREFIX);
        } catch (error) {
            return false;
        }
    }

    /**
     * Parse LFS pointer file content
     */
    private parseLFSPointer(content: Uint8Array): LFSPointer | null {
        try {
            const text = new TextDecoder().decode(content);

            if (!text.startsWith(GitService.LFS_POINTER_PREFIX)) {
                return null;
            }

            const lines = text.split("\n");
            let version = "";
            let oid = "";
            let size = 0;

            for (const line of lines) {
                if (line.startsWith("version ")) {
                    version = line.split(" ")[1];
                } else if (line.startsWith("oid sha256:")) {
                    oid = line.split(":")[1];
                } else if (line.startsWith("size ")) {
                    size = parseInt(line.split(" ")[1], 10);
                }
            }

            if (!version || !oid || !size) {
                return null;
            }

            return { version, oid, size };
        } catch (error) {
            console.error("Error parsing LFS pointer:", error);
            return null;
        }
    }

    /**
     * Create LFS pointer file content
     */
    private createLFSPointer(oid: string, size: number): string {
        return `${GitService.LFS_POINTER_PREFIX}
oid sha256:${oid}
size ${size}
`;
    }

    /**
     * Check if file should be tracked by LFS based on size and patterns
     */
    private shouldTrackWithLFS(filepath: string, size: number): boolean {
        // Check size threshold
        if (size >= GitService.LFS_SIZE_THRESHOLD) {
            return true;
        }

        // Check file extension patterns
        const filename = path.basename(filepath).toLowerCase();
        const extension = path.extname(filename);

        return GitService.LFS_TRACKING_PATTERNS.some((pattern) => {
            const regex = new RegExp(pattern.replace(/\*/g, ".*"));
            return regex.test(filename) || regex.test(extension);
        });
    }

    /**
     * Get LFS object from cache or download from server
     */
    private async getLFSObject(
        pointer: LFSPointer,
        auth: { username: string; password: string },
        gitlabBaseUrl: string
    ): Promise<Uint8Array> {
        const cacheKey = `${GitService.LFS_CACHE_KEY}_${pointer.oid}`;

        // Try to get from cache first (using VS Code's globalState for caching)
        try {
            const cached = vscode.workspace.getConfiguration("frontier").get<number[]>(cacheKey);
            if (cached) {
                this.debugLog(`LFS object found in cache: ${pointer.oid}`);
                return new Uint8Array(cached);
            }
        } catch (error) {
            this.debugLog(`Cache miss for LFS object: ${pointer.oid}`);
        }

        // Download from GitLab LFS API
        this.debugLog(`Downloading LFS object: ${pointer.oid} (${pointer.size} bytes)`);

        try {
            const lfsEndpoint = `${gitlabBaseUrl}/objects/batch`;

            const batchRequest: LFSBatchRequest = {
                operation: "download",
                objects: [
                    {
                        oid: pointer.oid,
                        size: pointer.size,
                    },
                ],
            };

            const batchResponse = await fetch(lfsEndpoint, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${auth.password}`, // GitLab token
                    "Content-Type": "application/vnd.git-lfs+json",
                    Accept: "application/vnd.git-lfs+json",
                },
                body: JSON.stringify(batchRequest),
            });

            if (!batchResponse.ok) {
                throw new Error(`LFS batch request failed: ${batchResponse.statusText}`);
            }

            const batchData: LFSBatchResponse = await batchResponse.json();

            if (!batchData.objects || batchData.objects.length === 0) {
                throw new Error("No objects in LFS batch response");
            }

            const object = batchData.objects[0];

            if (object.error) {
                throw new Error(`LFS object error: ${object.error.message}`);
            }

            if (!object.actions?.download) {
                throw new Error("No download action in LFS batch response");
            }

            // Download the actual content
            const downloadResponse = await fetch(object.actions.download.href, {
                headers: object.actions.download.header || {},
            });

            if (!downloadResponse.ok) {
                throw new Error(`LFS download failed: ${downloadResponse.statusText}`);
            }

            const content = new Uint8Array(await downloadResponse.arrayBuffer());

            // Verify size
            if (content.length !== pointer.size) {
                throw new Error(
                    `LFS object size mismatch: expected ${pointer.size}, got ${content.length}`
                );
            }

            // Cache the object
            try {
                await vscode.workspace
                    .getConfiguration("frontier")
                    .update(cacheKey, Array.from(content), vscode.ConfigurationTarget.Global);
                this.debugLog(`Cached LFS object: ${pointer.oid}`);
            } catch (cacheError) {
                console.warn("Failed to cache LFS object:", cacheError);
            }

            return content;
        } catch (error) {
            console.error("Error downloading LFS object:", error);
            throw new Error(
                `Failed to download LFS object ${pointer.oid}: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Upload content to LFS and return pointer
     */
    private async uploadLFSObject(
        content: Uint8Array,
        auth: { username: string; password: string },
        gitlabBaseUrl: string
    ): Promise<LFSPointer> {
        const size = content.length;

        // Calculate SHA256 hash
        const hashBuffer = await crypto.subtle.digest("SHA-256", content);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const oid = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

        this.debugLog(`Uploading LFS object: ${oid} (${size} bytes)`);

        try {
            const lfsEndpoint = `${gitlabBaseUrl}/objects/batch`;

            const batchRequest: LFSBatchRequest = {
                operation: "upload",
                objects: [
                    {
                        oid,
                        size,
                    },
                ],
            };

            const batchResponse = await fetch(lfsEndpoint, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${auth.password}`, // GitLab token
                    "Content-Type": "application/vnd.git-lfs+json",
                    Accept: "application/vnd.git-lfs+json",
                },
                body: JSON.stringify(batchRequest),
            });

            if (!batchResponse.ok) {
                throw new Error(`LFS batch request failed: ${batchResponse.statusText}`);
            }

            const batchData: LFSBatchResponse = await batchResponse.json();

            if (!batchData.objects || batchData.objects.length === 0) {
                throw new Error("No objects in LFS batch response");
            }

            const object = batchData.objects[0];

            if (object.error) {
                throw new Error(`LFS object error: ${object.error.message}`);
            }

            // If upload action is provided, upload the content
            if (object.actions?.upload) {
                const uploadResponse = await fetch(object.actions.upload.href, {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/octet-stream",
                        ...object.actions.upload.header,
                    },
                    body: content,
                });

                if (!uploadResponse.ok) {
                    throw new Error(`LFS upload failed: ${uploadResponse.statusText}`);
                }
            }

            // Cache the object locally
            const cacheKey = `${GitService.LFS_CACHE_KEY}_${oid}`;
            try {
                await vscode.workspace
                    .getConfiguration("frontier")
                    .update(cacheKey, Array.from(content), vscode.ConfigurationTarget.Global);
                this.debugLog(`Cached uploaded LFS object: ${oid}`);
            } catch (cacheError) {
                console.warn("Failed to cache uploaded LFS object:", cacheError);
            }

            return {
                version: GitService.LFS_POINTER_PREFIX.split(" ")[1],
                oid,
                size,
            };
        } catch (error) {
            console.error("Error uploading LFS object:", error);
            throw new Error(
                `Failed to upload LFS object: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Update .gitattributes file to track LFS files
     */
    private async updateGitAttributes(dir: string, filepath: string): Promise<void> {
        try {
            const gitattributesPath = path.join(dir, ".gitattributes");
            const extension = path.extname(filepath);
            const pattern = extension ? `*${extension}` : filepath;
            const lfsRule = `${pattern} filter=lfs diff=lfs merge=lfs -text`;

            let content = "";
            try {
                content = await fs.promises.readFile(gitattributesPath, "utf8");
            } catch (error) {
                // File doesn't exist, that's ok
            }

            const lines = content.split("\n").filter((line) => line.trim());

            // Check if rule already exists
            const ruleExists = lines.some(
                (line) => line.includes(pattern) && line.includes("filter=lfs")
            );

            if (!ruleExists) {
                lines.push(lfsRule);
                const newContent = lines.join("\n") + "\n";
                await fs.promises.writeFile(gitattributesPath, newContent, "utf8");
                this.debugLog(`Added LFS tracking rule: ${lfsRule}`);
            }
        } catch (error) {
            console.error("Error updating .gitattributes:", error);
            // Don't throw, as this is not critical
        }
    }

    /**
     * Initialize LFS tracking for a repository
     */
    async initializeLFSTracking(dir: string): Promise<void> {
        try {
            const gitattributesPath = path.join(dir, ".gitattributes");
            const rules = GitService.LFS_TRACKING_PATTERNS.map(
                (pattern) => `${pattern} filter=lfs diff=lfs merge=lfs -text`
            ).join("\n");

            let existingContent = "";
            try {
                existingContent = await fs.promises.readFile(gitattributesPath, "utf8");
            } catch (error) {
                // File doesn't exist, that's ok
            }

            const existingLines = existingContent.split("\n").filter((line) => line.trim());
            const newRules = rules
                .split("\n")
                .filter((rule) => !existingLines.some((line) => line.includes(rule.split(" ")[0])));

            if (newRules.length > 0) {
                const combinedContent = [...existingLines, ...newRules].join("\n") + "\n";
                await fs.promises.writeFile(gitattributesPath, combinedContent, "utf8");

                console.log(`Initialized LFS tracking with ${newRules.length} new rules`);
                this.debugLog("LFS tracking rules:", newRules);
            }
        } catch (error) {
            console.error("Error initializing LFS tracking:", error);
            throw new Error(
                `Failed to initialize LFS tracking: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
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
        if (this.debugLogging) {
            if (data !== undefined) {
                console.log(message, JSON.stringify(data));
            } else {
                console.log(message);
            }
        }
    }

    /**
     * Wraps git operations with a timeout to prevent hanging indefinitely
     */
    private async withTimeout<T>(
        operation: Promise<T>,
        timeoutMs: number = 30000,
        operationName: string = "Git operation"
    ): Promise<T> {
        const startTime = Date.now();
        console.log(`[GitService] Starting ${operationName} with ${timeoutMs}ms timeout`);

        const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        try {
            const result = await Promise.race([operation, timeout]);
            const duration = Date.now() - startTime;
            console.log(`[GitService] ${operationName} completed successfully in ${duration}ms`);
            return result;
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
        console.log(`[GitService] Running network diagnostics...`);

        const diagnostics = {
            timestamp: new Date().toISOString(),
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "N/A",
            onlineStatus: typeof navigator !== "undefined" ? navigator.onLine : "Unknown",
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
                    httpStatus: response.status,
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
        const { force = false, ref, timeoutMs = 30000 } = options || {};

        console.log(`[GitService] Starting push operation:`, {
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

            console.log(`[GitService] Push context:`, {
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
                console.log(`[GitService] Authentication requested for push operation`);
                return auth;
            },
            ...(force && { force }),
        });

        try {
            await this.withTimeout(pushOperation, timeoutMs, "Push operation");
            console.log(`[GitService] Push completed successfully`);
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

    /**
     * Extract GitLab base URL from remote URL
     */
    private extractGitLabBaseUrl(remoteUrl: string): string {
        try {
            const url = new URL(remoteUrl);
            return `${url.protocol}//${url.host}`;
        } catch (error) {
            console.error("Error extracting GitLab base URL:", error);
            // Fallback to common GitLab URL
            return "https://gitlab.com";
        }
    }

    /**
     * Enhanced syncChanges with LFS support
     */
    async syncChanges(
        dir: string,
        auth: { username: string; password: string },
        author: { name: string; email: string }
    ): Promise<SyncResult> {
        // Check if sync is already in progress
        if (this.stateManager.isSyncLocked()) {
            console.log("Sync already in progress, skipping this request");
            return { hadConflicts: false };
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock();
        if (!lockAcquired) {
            console.log("Failed to acquire sync lock, skipping this request");
            return { hadConflicts: false };
        }

        try {
            const currentBranch = await git.currentBranch({ fs, dir });
            if (!currentBranch) {
                throw new Error("Not on any branch");
            }

            // Get GitLab base URL from remote URL for LFS operations
            const remoteUrl = await this.getRemoteUrl(dir);
            const gitlabBaseUrl = remoteUrl
                ? this.extractGitLabBaseUrl(remoteUrl)
                : "https://gitlab.com";

            // Initialize LFS tracking if not already done
            try {
                await this.initializeLFSTracking(dir);
            } catch (error) {
                console.warn("Failed to initialize LFS tracking:", error);
                // Continue anyway, as this is not critical for sync
            }

            // 1. Commit local changes if needed
            const { isDirty, status: workingCopyStatusBeforeCommit } =
                await this.getWorkingCopyState(dir);
            if (isDirty) {
                console.log("Working copy is dirty, committing local changes");
                await this.addAll(dir);
                await this.commit(dir, "Local changes", author);
            }

            // 2. Check if we're online
            if (!(await this.isOnline())) {
                throw new Error("Offline");
            }

            // 3. Fetch remote changes to get latest state
            console.log("[GitService] Fetching remote changes");
            try {
                await this.withTimeout(
                    git.fetch({
                        fs,
                        http,
                        dir,
                        onAuth: () => {
                            console.log(
                                "[GitService] Authentication requested for fetch operation"
                            );
                            return auth;
                        },
                    }),
                    30000,
                    "Fetch operation"
                );
                console.log("[GitService] Fetch completed successfully");
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
                console.log("Remote branch doesn't exist, pushing our changes");
                await this.safePush(dir, auth);
                return { hadConflicts: false };
            }

            const mergeBaseCommits = await git.findMergeBase({
                fs,
                dir,
                oids: [localHead, remoteHead],
            });

            this.debugLog("Merge base commits:", mergeBaseCommits);

            // Get files changed in local HEAD
            const localStatusMatrix = await git.statusMatrix({ fs, dir });
            // Get files changed in remote HEAD
            const remoteStatusMatrix = await git.statusMatrix({
                fs,
                dir,
                ref: remoteRef,
            });
            const mergeBaseStatusMatrix =
                mergeBaseCommits.length > 0
                    ? await git.statusMatrix({
                          fs,
                          dir,
                          ref: mergeBaseCommits[0],
                      })
                    : [];

            this.debugLog("workingCopyStatusBeforeCommit:", workingCopyStatusBeforeCommit);
            this.debugLog("localStatusMatrix:", localStatusMatrix);
            this.debugLog("mergeBaseStatusMatrix:", mergeBaseStatusMatrix);
            this.debugLog("remoteStatusMatrix:", remoteStatusMatrix);

            // 6. If local and remote are identical, nothing to do
            if (localHead === remoteHead) {
                console.log("Local and remote are already in sync");
                return { hadConflicts: false };
            }

            // 7. Try fast-forward first (simplest case)
            try {
                console.log("[GitService] Attempting fast-forward merge");
                console.log("[GitService] Fast-forward context:", {
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
                            console.log("[GitService] Authentication requested for fast-forward");
                            return auth;
                        },
                    }),
                    30000,
                    "Fast-forward operation"
                );

                // Fast-forward worked, push any local changes
                console.log("[GitService] Fast-forward successful, pushing any local changes");
                await this.safePush(dir, auth);

                return { hadConflicts: false };
            } catch (err) {
                console.log("[GitService] Fast-forward failed, analyzing conflicts:", {
                    error: err instanceof Error ? err.message : String(err),
                    localHead: localHead.substring(0, 8),
                    remoteHead: remoteHead.substring(0, 8),
                });
            }

            // 8. If we get here, we have divergent histories - check for conflicts
            console.log("Fast-forward failed, need to handle conflicts");

            // Convert status matrices to maps for easier lookup
            const localStatusMap = new Map(
                localStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const remoteStatusMap = new Map(
                remoteStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
            );
            const mergeBaseStatusMap = new Map(
                mergeBaseStatusMatrix.map((entry) => [entry[0], entry.slice(1)])
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
                    remoteStatus[0] === 1 &&
                    (!localStatus || localStatus[0] === 0) &&
                    (!mergeBaseStatus || mergeBaseStatus[0] === 0)
                ) {
                    filesAddedOnRemote.push(filepath);
                    continue;
                }

                // File exists in local but not in remote or merge base -> added locally
                if (
                    localStatus &&
                    localStatus[0] === 1 &&
                    (!remoteStatus || remoteStatus[0] === 0) &&
                    (!mergeBaseStatus || mergeBaseStatus[0] === 0)
                ) {
                    filesAddedLocally.push(filepath);
                    continue;
                }

                // File exists in merge base and local but not in remote -> deleted on remote
                if (
                    mergeBaseStatus &&
                    mergeBaseStatus[0] === 1 &&
                    localStatus &&
                    localStatus[0] === 1 &&
                    (!remoteStatus || remoteStatus[0] === 0)
                ) {
                    filesDeletedOnRemote.push(filepath);
                    continue;
                }

                // File exists in merge base and remote but not in local -> deleted locally
                if (
                    mergeBaseStatus &&
                    mergeBaseStatus[0] === 1 &&
                    remoteStatus &&
                    remoteStatus[0] === 1 &&
                    (!localStatus || localStatus[0] === 0)
                ) {
                    filesDeletedLocally.push(filepath);
                    continue;
                }

                // File exists in all three but has different content
                if (
                    localStatus &&
                    localStatus[0] === 1 &&
                    remoteStatus &&
                    remoteStatus[0] === 1 &&
                    mergeBaseStatus &&
                    mergeBaseStatus[0] === 1
                ) {
                    const localModified = localStatus[1] === 2; // workdir different from HEAD
                    const remoteModified = remoteStatus[1] === 2; // workdir different from HEAD
                    const mergeBaseModified = mergeBaseStatus[1] === 2; // merge base different from HEAD

                    // Treat all modified files as potential conflicts for simplicity
                    if (localModified || remoteModified || mergeBaseModified) {
                        filesModifiedAndTreatedAsPotentialConflict.push(filepath);
                    }
                }
            }

            // Additional validation to ensure files are properly categorized
            // Filter out files from filesDeletedLocally that are actually added on remote
            // const updatedFilesDeletedLocally = filesDeletedLocally.filter(
            //     (filepath) => !filesAddedOnRemote.includes(filepath)
            // );

            // // Reassign the array contents while preserving the original reference
            // filesDeletedLocally.length = 0;
            // filesDeletedLocally.push(...updatedFilesDeletedLocally);

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

            // 9. Get all files changed in either branch with enhanced conflict detection and LFS support
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
                    // A file is truly deleted if:
                    // 1. It's deleted locally and not modified remotely (user wants to delete)
                    // 2. It's deleted remotely and not modified locally (remote deleted it)
                    isDeleted =
                        (isDeletedLocally && !isAddedRemotely) ||
                        (isDeletedRemotely && !isAddedLocally);

                    // Try to read local content with LFS support if it exists in local HEAD
                    try {
                        if (!isDeletedLocally && !isAddedLocally) {
                            const { blob, isLFS } = await this.readBlobWithLFS(
                                dir,
                                localHead,
                                filepath,
                                auth,
                                gitlabBaseUrl
                            );
                            localContent = new TextDecoder().decode(blob);
                            this.debugLog(
                                `Local file ${filepath} ${isLFS ? "(LFS)" : "(regular)"} read successfully`
                            );
                        } else if (isAddedLocally) {
                            // For locally added files, read from working directory
                            try {
                                const fileBuffer = await fs.promises.readFile(
                                    path.join(dir, filepath)
                                );

                                // Check if this is an LFS pointer file
                                if (this.isLFSPointer(fileBuffer)) {
                                    const pointer = this.parseLFSPointer(fileBuffer);
                                    if (pointer) {
                                        const lfsContent = await this.getLFSObject(
                                            pointer,
                                            auth,
                                            gitlabBaseUrl
                                        );
                                        localContent = new TextDecoder().decode(lfsContent);
                                        this.debugLog(
                                            `Local added file ${filepath} (LFS) read successfully`
                                        );
                                    } else {
                                        localContent = new TextDecoder().decode(fileBuffer);
                                    }
                                } else {
                                    localContent = new TextDecoder().decode(fileBuffer);
                                }
                            } catch (e) {
                                this.debugLog(`Error reading locally added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in local HEAD`);
                    }

                    // Try to read remote content with LFS support if it exists in remote HEAD
                    try {
                        if (!isDeletedRemotely && !isAddedRemotely) {
                            const { blob, isLFS } = await this.readBlobWithLFS(
                                dir,
                                remoteHead,
                                filepath,
                                auth,
                                gitlabBaseUrl
                            );
                            remoteContent = new TextDecoder().decode(blob);
                            this.debugLog(
                                `Remote file ${filepath} ${isLFS ? "(LFS)" : "(regular)"} read successfully`
                            );
                        } else if (isAddedRemotely) {
                            // For remotely added files, we need to read from remote HEAD
                            try {
                                const { blob, isLFS } = await this.readBlobWithLFS(
                                    dir,
                                    remoteHead,
                                    filepath,
                                    auth,
                                    gitlabBaseUrl
                                );
                                remoteContent = new TextDecoder().decode(blob);
                                this.debugLog(
                                    `Remote added file ${filepath} ${isLFS ? "(LFS)" : "(regular)"} read successfully`
                                );
                            } catch (e) {
                                this.debugLog(`Error reading remotely added file ${filepath}:`, e);
                            }
                        }
                    } catch (err) {
                        this.debugLog(`File ${filepath} doesn't exist in remote HEAD`);
                    }

                    // Try to read base content with LFS support if available
                    try {
                        if (mergeBaseCommits.length > 0) {
                            const { blob, isLFS } = await this.readBlobWithLFS(
                                dir,
                                mergeBaseCommits[0],
                                filepath,
                                auth,
                                gitlabBaseUrl
                            );
                            baseContent = new TextDecoder().decode(blob);
                            this.debugLog(
                                `Base file ${filepath} ${isLFS ? "(LFS)" : "(regular)"} read successfully`
                            );
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

            console.log(`Found ${conflicts.length} conflicts that need resolution`);
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
        console.log(
            "Status before committing local changes:",
            JSON.stringify(
                status.filter(
                    (entry) => entry.includes(0) || entry.includes(2) || entry.includes(3)
                )
            )
        );
        return { isDirty: status.some((entry) => this.fileStatus.isAnyChange(entry)), status };
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
            console.log("Sync already in progress, cannot complete merge");
            throw new Error("Sync operation already in progress. Please try again later.");
        }

        // Try to acquire the sync lock
        const lockAcquired = await this.stateManager.acquireSyncLock();
        if (!lockAcquired) {
            console.log("Failed to acquire sync lock, cannot complete merge");
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

            // Stage the resolved files based on their resolution type
            for (const { filepath, resolution } of resolvedFiles) {
                this.debugLog(
                    `Processing resolved file: ${filepath} with resolution: ${resolution}`
                );

                if (resolution === "deleted") {
                    console.log(`Removing file from git: ${filepath}`);
                    await git.remove({ fs, dir, filepath });
                } else {
                    console.log(`Adding file to git: ${filepath}`);
                    await git.add({ fs, dir, filepath });
                }
            }

            // Get the current state before creating the merge commit
            const localHead = await git.resolveRef({ fs, dir, ref: currentBranch });
            const remoteRef = this.getRemoteRef(currentBranch);
            const remoteHead = await git.resolveRef({ fs, dir, ref: remoteRef });

            // Fetch latest changes to ensure we have the most recent remote state
            console.log("[GitService] Fetching latest changes before merge completion");
            await this.withTimeout(
                git.fetch({
                    fs,
                    http,
                    dir,
                    onAuth: () => {
                        console.log("[GitService] Authentication requested for pre-merge fetch");
                        return auth;
                    },
                }),
                30000,
                "Pre-merge fetch operation"
            );
            const commitMessage = `Merge branch 'origin/${currentBranch}'`;
            console.log(`Creating merge commit with message: ${commitMessage}`);

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
                console.log("Attempting to create a regular commit with the resolved changes");
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
            console.log("Pushing merge commit");
            try {
                // Try normal push first
                await this.safePush(dir, auth, { ref: currentBranch });
                console.log("Successfully pushed merge commit");
            } catch (pushError) {
                console.error("Error pushing merge commit:", pushError);
            }

            console.log("=== completeMerge completed successfully ===");
        } catch (error) {
            console.error("Complete merge error:", error);
            throw error;
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
    }

    async add(dir: string, filepath: string): Promise<void> {
        await git.add({ fs, dir, filepath });
    }

    async remove(dir: string, filepath: string): Promise<void> {
        await git.remove({ fs, dir, filepath });
    }

    async getStatus(dir: string): Promise<Array<[string, number, number, number]>> {
        return git.statusMatrix({ fs, dir });
    }

    async getCurrentBranch(dir: string): Promise<string | undefined> {
        return (await git.currentBranch({ fs, dir })) || undefined;
    }

    async listBranches(dir: string): Promise<string[]> {
        return git.listBranches({ fs, dir });
    }

    async checkout(dir: string, ref: string): Promise<void> {
        await git.checkout({ fs, dir, ref });
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

    async removeRemote(dir: string, name: string): Promise<void> {
        try {
            await git.deleteRemote({ fs, dir, remote: name });
        } catch (error) {
            console.error(`Error removing remote ${name}:`, error);
            // If the remote doesn't exist, that's fine
            if (!(error instanceof Error && error.message.includes("remote does not exist"))) {
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

    async getConfig(dir: string, path: string): Promise<string | void> {
        return git.getConfig({ fs, dir, path });
    }

    async push(
        dir: string,
        auth: { username: string; password: string },
        options?: { force?: boolean }
    ): Promise<void> {
        await this.safePush(dir, auth, { force: options?.force });
    }

    async isOnline(): Promise<boolean> {
        try {
            // Check internet connectivity by making HEAD requests and checking response codes
            const userIsOnline = await fetch("https://gitlab.com", {
                method: "HEAD",
                cache: "no-store", // Prevent caching
            })
                .then((res) => res.status === 200)
                .catch(() => false);

            const apiIsOnline = await fetch("https://api.frontierrnd.com")
                .then((res) => {
                    console.log("RYDER: apiIsOnline", { res });
                    return res.status === 200;
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
     * Helper method to resolve a reference to a commit hash
     * @param dir The repository directory
     * @param ref The reference to resolve
     * @returns The commit hash
     */
    private async resolveReference(dir: string, ref: string): Promise<string> {
        return git.resolveRef({ fs, dir, ref });
    }

    /**
     * Helper method to resolve a remote branch reference to a commit hash
     * @param dir The repository directory
     * @param branch The branch name
     * @returns The commit hash of the remote branch
     */
    private async resolveRemoteReference(dir: string, branch: string): Promise<string> {
        return this.resolveReference(dir, this.getRemoteRef(branch));
    }

    async fastForward(
        dir: string,
        currentBranch: string,
        auth: { username: string; password: string }
    ): Promise<boolean> {
        try {
            // Fetch the latest changes from the remote
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });

            // Get the current commit
            const currentCommit = await git.resolveRef({
                fs,
                dir,
                ref: currentBranch,
            });

            // Get the remote commit
            const remoteRef = this.getRemoteRef(currentBranch);
            const remoteCommit = await git.resolveRef({
                fs,
                dir,
                ref: remoteRef,
            });

            // Fast-forward just updates local HEAD to match remote, no pushing needed
            await git.fastForward({
                fs,
                http,
                dir,
                ref: currentBranch,
                onAuth: () => auth,
            });

            return true;
        } catch (error) {
            console.log("Fast-forward failed, identifying conflicts");
            return false;
        }
    }

    async getRemoteBranchStatus(
        dir: string,
        currentBranch: string,
        auth: { username: string; password: string }
    ): Promise<RemoteBranchStatus> {
        try {
            // Fetch the latest changes from the remote
            await git.fetch({
                fs,
                http,
                dir,
                onAuth: () => auth,
            });

            // Check if the remote branch exists
            try {
                await git.resolveRef({
                    fs,
                    dir,
                    ref: this.getRemoteRef(currentBranch),
                });
            } catch (error) {
                // Remote branch doesn't exist
                return RemoteBranchStatus.NOT_FOUND;
            }

            return RemoteBranchStatus.FOUND;
        } catch (error) {
            console.error("Error getting remote branch status:", error);
            return RemoteBranchStatus.ERROR;
        }
    }

    async mergeRemote(
        dir: string,
        currentBranch: string,
        auth: { username: string; password: string }
    ): Promise<boolean> {
        try {
            // Merge the remote branch into the current branch
            await git.merge({
                fs,
                dir,
                ours: currentBranch,
                theirs: this.getRemoteRef(currentBranch),
                author: {
                    name: "Genesis",
                    email: "genesis@example.com",
                },
                message: `Merge branch '${this.getShortRemoteRef(currentBranch)}' into ${currentBranch}`,
            });
            return true;
        } catch (error) {
            console.error("Error merging remote branch:", error);
            return false;
        }
    }

    async checkoutRemote(dir: string, currentBranch: string): Promise<void> {
        await git.checkout({
            fs,
            dir,
            ref: this.getShortRemoteRef(currentBranch),
        });
    }

    // Add this helper method to the GitService class
    private areStatusEntriesEqual(
        entry1?: [string, number, number, number],
        entry2?: [string, number, number, number]
    ): boolean {
        if (!entry1 || !entry2) {
            return false;
        }
        // Compare HEAD status (index 1)
        return entry1[1] === entry2[1];
    }

    /**
     * Public method to check if a file should be tracked by LFS
     */
    public shouldFileUseEFS(filepath: string, size: number): boolean {
        return this.shouldTrackWithLFS(filepath, size);
    }

    /**
     * Public method to initialize LFS tracking for a repository
     */
    public async setupLFSTracking(dir: string): Promise<void> {
        try {
            await this.initializeLFSTracking(dir);
            console.log("LFS tracking initialized successfully");
        } catch (error) {
            console.error("Failed to setup LFS tracking:", error);
            throw new Error(
                `Failed to setup LFS tracking: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Public method to check if content is an LFS pointer
     */
    public isContentLFSPointer(content: Uint8Array): boolean {
        return this.isLFSPointer(content);
    }

    /**
     * Public method to get LFS object content
     */
    public async getLFSContent(
        pointer: LFSPointer,
        auth: { username: string; password: string },
        gitlabBaseUrl: string
    ): Promise<Uint8Array> {
        try {
            return await this.getLFSObject(pointer, auth, gitlabBaseUrl);
        } catch (error) {
            console.error("Failed to get LFS content:", error);
            throw new Error(
                `Failed to get LFS content: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Public method to upload content to LFS
     */
    public async uploadToLFS(
        content: Uint8Array,
        auth: { username: string; password: string },
        gitlabBaseUrl: string
    ): Promise<LFSPointer> {
        try {
            return await this.uploadLFSObject(content, auth, gitlabBaseUrl);
        } catch (error) {
            console.error("Failed to upload to LFS:", error);
            throw new Error(
                `Failed to upload to LFS: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Enhanced error handling for LFS operations with fallback strategies
     */
    private async handleLFSError(error: any, operation: string, filepath?: string): Promise<void> {
        const errorMessage = error instanceof Error ? error.message : String(error);

        console.error(`[GitService] LFS ${operation} failed:`, {
            error: errorMessage,
            filepath,
            timestamp: new Date().toISOString(),
            operation,
        });

        // Specific error handling for common LFS issues
        if (errorMessage.includes("timeout")) {
            console.warn(
                `[GitService] LFS operation timed out, this might be due to large file size or network issues`
            );
        } else if (errorMessage.includes("404") || errorMessage.includes("Not Found")) {
            console.warn(`[GitService] LFS object not found, might be missing from server`);
        } else if (errorMessage.includes("401") || errorMessage.includes("403")) {
            console.warn(`[GitService] LFS authentication failed, check GitLab token permissions`);
        } else if (
            errorMessage.includes("413") ||
            errorMessage.includes("Request Entity Too Large")
        ) {
            console.warn(`[GitService] File too large for LFS upload, check GitLab LFS limits`);
        } else if (errorMessage.includes("422") || errorMessage.includes("Unprocessable Entity")) {
            console.warn(`[GitService] LFS server rejected request, check file format and size`);
        } else if (
            errorMessage.includes("500") ||
            errorMessage.includes("502") ||
            errorMessage.includes("503")
        ) {
            console.warn(`[GitService] LFS server error, might be temporary - consider retrying`);
        }

        // Show user-friendly error message
        if (filepath) {
            vscode.window.showErrorMessage(
                `LFS ${operation} failed for file ${filepath}. Check connection and GitLab settings.`
            );
        } else {
            vscode.window.showErrorMessage(
                `LFS ${operation} failed. Check connection and GitLab settings.`
            );
        }
    }

    /**
     * Enhanced blob reading with LFS support and error handling
     */
    async readBlobWithLFS(
        dir: string,
        oid: string,
        filepath: string,
        auth: { username: string; password: string },
        gitlabBaseUrl: string
    ): Promise<{ blob: Uint8Array; isLFS: boolean }> {
        try {
            const gitObject = await git.readBlob({ fs, dir, oid, filepath });

            if (this.isLFSPointer(gitObject.blob)) {
                const pointer = this.parseLFSPointer(gitObject.blob);
                if (pointer) {
                    try {
                        const lfsContent = await this.getLFSObject(pointer, auth, gitlabBaseUrl);
                        return { blob: lfsContent, isLFS: true };
                    } catch (lfsError) {
                        await this.handleLFSError(lfsError, "download", filepath);

                        // Fallback: return pointer content as-is
                        console.warn(
                            `[GitService] LFS download failed, returning pointer content for ${filepath}`
                        );
                        return { blob: gitObject.blob, isLFS: false };
                    }
                }
            }

            return { blob: gitObject.blob, isLFS: false };
        } catch (error) {
            console.error(`Error reading blob with LFS support: ${filepath}`, error);
            await this.handleLFSError(error, "read", filepath);
            throw error;
        }
    }

    /**
     * Enhanced file writing with LFS support and error handling
     */
    async writeBlobWithLFS(
        dir: string,
        filepath: string,
        content: Uint8Array,
        auth: { username: string; password: string },
        gitlabBaseUrl: string
    ): Promise<void> {
        try {
            const fullPath = path.join(dir, filepath);
            const size = content.length;

            if (this.shouldTrackWithLFS(filepath, size)) {
                this.debugLog(`File ${filepath} should be tracked with LFS (size: ${size} bytes)`);

                try {
                    // Upload to LFS and create pointer
                    const pointer = await this.uploadLFSObject(content, auth, gitlabBaseUrl);
                    const pointerContent = this.createLFSPointer(pointer.oid, pointer.size);

                    // Write pointer file instead of actual content
                    await fs.promises.writeFile(fullPath, pointerContent, "utf8");

                    // Ensure .gitattributes is updated
                    await this.updateGitAttributes(dir, filepath);

                    console.log(
                        `[GitService] Successfully uploaded ${filepath} to LFS (${size} bytes)`
                    );
                } catch (lfsError) {
                    await this.handleLFSError(lfsError, "upload", filepath);

                    // Fallback: write file normally if LFS fails
                    console.warn(
                        `[GitService] LFS upload failed, writing ${filepath} as regular file`
                    );
                    await fs.promises.writeFile(fullPath, content);
                }
            } else {
                // Write normal file
                await fs.promises.writeFile(fullPath, content);
            }
        } catch (error) {
            console.error(`Error writing blob with LFS support: ${filepath}`, error);
            await this.handleLFSError(error, "write", filepath);
            throw error;
        }
    }

    /**
     * Clear LFS cache for a specific object or all objects
     */
    public async clearLFSCache(oid?: string): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration("frontier");

            if (oid) {
                // Clear specific object
                const cacheKey = `${GitService.LFS_CACHE_KEY}_${oid}`;
                await config.update(cacheKey, undefined, vscode.ConfigurationTarget.Global);
                console.log(`[GitService] Cleared LFS cache for object: ${oid}`);
            } else {
                // Clear all LFS cache (get all config keys and filter)
                const allSettings = config.inspect("");
                if (allSettings?.globalValue) {
                    const globalConfig = allSettings.globalValue as Record<string, any>;
                    const lfsKeys = Object.keys(globalConfig).filter((key) =>
                        key.startsWith(GitService.LFS_CACHE_KEY)
                    );

                    for (const key of lfsKeys) {
                        await config.update(key, undefined, vscode.ConfigurationTarget.Global);
                    }
                    console.log(`[GitService] Cleared ${lfsKeys.length} LFS cache entries`);
                }
            }
        } catch (error) {
            console.error("Error clearing LFS cache:", error);
            throw new Error(
                `Failed to clear LFS cache: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Get LFS cache statistics
     */
    public async getLFSCacheStats(): Promise<{ totalObjects: number; totalSize: number }> {
        try {
            const config = vscode.workspace.getConfiguration("frontier");
            const allSettings = config.inspect("");

            if (!allSettings?.globalValue) {
                return { totalObjects: 0, totalSize: 0 };
            }

            const globalConfig = allSettings.globalValue as Record<string, any>;
            const lfsKeys = Object.keys(globalConfig).filter((key) =>
                key.startsWith(GitService.LFS_CACHE_KEY)
            );

            let totalSize = 0;
            for (const key of lfsKeys) {
                const value = globalConfig[key];
                if (Array.isArray(value)) {
                    totalSize += value.length;
                }
            }

            return {
                totalObjects: lfsKeys.length,
                totalSize,
            };
        } catch (error) {
            console.error("Error getting LFS cache stats:", error);
            return { totalObjects: 0, totalSize: 0 };
        }
    }
}
