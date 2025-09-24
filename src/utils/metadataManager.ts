import * as vscode from "vscode";

/**
 * Thread-safe metadata manager that prevents conflicts between extensions
 * when modifying metadata.json files.
 */

interface MetadataLock {
    extensionId: string;
    timestamp: number;
    pid: number;
}

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

interface MetadataUpdateOptions {
    retryCount?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
}

export class MetadataManager {
    private static readonly LOCK_TIMEOUT_MS = 30000; // 30 seconds
    private static readonly MAX_RETRIES = 5;
    private static readonly RETRY_DELAY_MS = 100;
    private static readonly EXTENSION_ID = "frontier-rnd.frontier-authentication";

    /**
     * Safely update metadata.json with atomic operations and conflict prevention
     */
    static async safeUpdateMetadata<T = ProjectMetadata>(
        workspaceUri: vscode.Uri,
        updateFunction: (metadata: T) => T | Promise<T>,
        options: MetadataUpdateOptions = {}
    ): Promise<{ success: boolean; metadata?: T; error?: string }> {
        const {
            retryCount = this.MAX_RETRIES,
            retryDelayMs = this.RETRY_DELAY_MS,
            timeoutMs = this.LOCK_TIMEOUT_MS
        } = options;

        const metadataPath = vscode.Uri.joinPath(workspaceUri, "metadata.json");
        const lockPath = vscode.Uri.joinPath(workspaceUri, ".metadata.lock");

        for (let attempt = 0; attempt < retryCount; attempt++) {
            try {
                // Step 1: Acquire lock
                const lockAcquired = await this.acquireLock(lockPath, timeoutMs);
                if (!lockAcquired) {
                    if (attempt === retryCount - 1) {
                        return { success: false, error: "Failed to acquire metadata lock after all retries" };
                    }
                    await this.sleep(retryDelayMs * (attempt + 1)); // Exponential backoff
                    continue;
                }

                try {
                    // Step 2: Read current metadata with conflict detection
                    const readResult = await this.safeReadMetadata<T>(metadataPath);
                    if (!readResult.success) {
                        return { success: false, error: readResult.error };
                    }

                    // Step 3: Apply updates
                    const originalMetadata = readResult.metadata!;
                    const updatedMetadata = await updateFunction(originalMetadata);

                    // Step 4: Write back with atomic operation
                    const writeResult = await this.atomicWriteMetadata(metadataPath, updatedMetadata);
                    if (!writeResult.success) {
                        return { success: false, error: writeResult.error };
                    }

                    return { success: true, metadata: updatedMetadata };

                } finally {
                    // Step 5: Always release lock
                    await this.releaseLock(lockPath);
                }

            } catch (error) {
                console.warn(`[MetadataManager] Attempt ${attempt + 1} failed:`, error);
                if (attempt === retryCount - 1) {
                    return { 
                        success: false, 
                        error: `All ${retryCount} attempts failed. Last error: ${(error as Error).message}` 
                    };
                }
                await this.sleep(retryDelayMs * (attempt + 1));
            }
        }

        return { success: false, error: "Unexpected error in metadata update" };
    }

    /**
     * Safely read metadata with validation
     */
    private static async safeReadMetadata<T>(
        metadataPath: vscode.Uri
    ): Promise<{ success: boolean; metadata?: T; error?: string }> {
        try {
            const content = await vscode.workspace.fs.readFile(metadataPath);
            const text = new TextDecoder().decode(content);
            
            // Validate JSON structure
            let metadata: T;
            try {
                metadata = JSON.parse(text);
            } catch (parseError) {
                return { 
                    success: false, 
                    error: `Invalid JSON in metadata.json: ${(parseError as Error).message}` 
                };
            }

            return { success: true, metadata };

        } catch (error) {
            if ((error as any).code === 'FileNotFound') {
                // Create empty metadata if file doesn't exist
                const emptyMetadata = {} as T;
                return { success: true, metadata: emptyMetadata };
            }
            return { 
                success: false, 
                error: `Failed to read metadata.json: ${(error as Error).message}` 
            };
        }
    }

    /**
     * Atomic write operation with backup and rollback
     */
    private static async atomicWriteMetadata<T>(
        metadataPath: vscode.Uri,
        metadata: T
    ): Promise<{ success: boolean; error?: string }> {
        const workspaceUri = vscode.Uri.joinPath(metadataPath, "..");
        const backupPath = vscode.Uri.joinPath(workspaceUri, ".metadata.json.backup");
        const tempPath = vscode.Uri.joinPath(workspaceUri, ".metadata.json.tmp");

        try {
            // Step 1: Create backup of existing file
            try {
                const existingContent = await vscode.workspace.fs.readFile(metadataPath);
                await vscode.workspace.fs.writeFile(backupPath, existingContent);
            } catch (error) {
                // File might not exist, which is fine
                if ((error as any).code !== 'FileNotFound') {
                    console.warn("[MetadataManager] Failed to create backup:", error);
                }
            }

            // Step 2: Write to temporary file
            const jsonContent = JSON.stringify(metadata, null, 4);
            const encoded = new TextEncoder().encode(jsonContent);
            await vscode.workspace.fs.writeFile(tempPath, encoded);

            // Step 3: Validate the temporary file
            try {
                const validateContent = await vscode.workspace.fs.readFile(tempPath);
                const validateText = new TextDecoder().decode(validateContent);
                JSON.parse(validateText); // Throws if invalid
            } catch (validateError) {
                await this.cleanupFile(tempPath);
                return { 
                    success: false, 
                    error: `Validation failed for temporary file: ${(validateError as Error).message}` 
                };
            }

            // Step 4: Atomic rename (move temp to final location)
            await vscode.workspace.fs.rename(tempPath, metadataPath, { overwrite: true });

            // Step 5: Cleanup backup after successful write
            await this.cleanupFile(backupPath);

            return { success: true };

        } catch (error) {
            // Rollback on failure
            await this.cleanupFile(tempPath);
            
            try {
                // Restore from backup if it exists
                const backupContent = await vscode.workspace.fs.readFile(backupPath);
                await vscode.workspace.fs.writeFile(metadataPath, backupContent);
                await this.cleanupFile(backupPath);
                console.log("[MetadataManager] Successfully restored from backup");
            } catch (restoreError) {
                console.warn("[MetadataManager] Failed to restore from backup:", restoreError);
            }

            return { 
                success: false, 
                error: `Atomic write failed: ${(error as Error).message}` 
            };
        }
    }

    /**
     * Acquire exclusive lock on metadata file
     */
    private static async acquireLock(
        lockPath: vscode.Uri, 
        timeoutMs: number
    ): Promise<boolean> {
        const startTime = Date.now();
        const lockData: MetadataLock = {
            extensionId: this.EXTENSION_ID,
            timestamp: startTime,
            pid: process.pid
        };

        while (Date.now() - startTime < timeoutMs) {
            try {
                // Check if lock file already exists
                const existingContent = await vscode.workspace.fs.readFile(lockPath);
                const existingLock: MetadataLock = JSON.parse(new TextDecoder().decode(existingContent));
                
                // Check if lock is stale (older than timeout)
                if (Date.now() - existingLock.timestamp > this.LOCK_TIMEOUT_MS) {
                    console.log(`[MetadataManager] Removing stale lock from ${existingLock.extensionId}`);
                    await this.cleanupFile(lockPath);
                    // Continue to try creating new lock
                } else {
                    // Lock is still valid, wait and retry
                    await this.sleep(50);
                    continue;
                }
            } catch (error) {
                // Lock file doesn't exist or is corrupted, we can proceed
            }

            try {
                // Try to create lock file
                const lockContent = JSON.stringify(lockData);
                const encoded = new TextEncoder().encode(lockContent);
                await vscode.workspace.fs.writeFile(lockPath, encoded);
                
                // Verify we actually got the lock (race condition check)
                await this.sleep(10); // Small delay to catch race conditions
                const verifyContent = await vscode.workspace.fs.readFile(lockPath);
                const verifyLock: MetadataLock = JSON.parse(new TextDecoder().decode(verifyContent));
                
                if (verifyLock.extensionId === this.EXTENSION_ID && verifyLock.timestamp === lockData.timestamp) {
                    return true; // Successfully acquired lock
                } else {
                    // Someone else got the lock first
                    await this.sleep(50);
                    continue;
                }
            } catch (error) {
                // Failed to create or verify lock, retry
                await this.sleep(50);
                continue;
            }
        }

        return false;
    }

    /**
     * Release the metadata lock
     */
    private static async releaseLock(lockPath: vscode.Uri): Promise<void> {
        await this.cleanupFile(lockPath);
    }

    /**
     * Utility to safely delete a file
     */
    private static async cleanupFile(filePath: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.delete(filePath);
        } catch (error) {
            // File might not exist, which is fine
            if ((error as any).code !== 'FileNotFound') {
                console.warn(`[MetadataManager] Failed to cleanup file ${filePath.fsPath}:`, error);
            }
        }
    }

    /**
     * Utility sleep function
     */
    private static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Convenience method specifically for extension version updates
     */
    static async updateExtensionVersions(
        workspaceUri: vscode.Uri,
        versions: {
            codexEditor?: string;
            frontierAuthentication?: string;
        }
    ): Promise<{ success: boolean; error?: string }> {
        const result = await this.safeUpdateMetadata<ProjectMetadata>(
            workspaceUri,
            (metadata) => {
                // Ensure meta section exists
                if (!metadata.meta) {
                    metadata.meta = {};
                }

                // Ensure requiredExtensions section exists
                if (!metadata.meta.requiredExtensions) {
                    metadata.meta.requiredExtensions = {};
                }

                // Update only the provided versions
                if (versions.codexEditor !== undefined) {
                    metadata.meta.requiredExtensions.codexEditor = versions.codexEditor;
                }
                if (versions.frontierAuthentication !== undefined) {
                    metadata.meta.requiredExtensions.frontierAuthentication = versions.frontierAuthentication;
                }

                return metadata;
            }
        );

        return { success: result.success, error: result.error };
    }

    /**
     * Convenience method to read current extension versions
     */
    static async getExtensionVersions(
        workspaceUri: vscode.Uri
    ): Promise<{ 
        success: boolean; 
        versions?: { codexEditor?: string; frontierAuthentication?: string }; 
        error?: string 
    }> {
        const metadataPath = vscode.Uri.joinPath(workspaceUri, "metadata.json");
        const result = await this.safeReadMetadata<ProjectMetadata>(metadataPath);
        
        if (!result.success) {
            return { success: false, error: result.error };
        }

        const versions = result.metadata?.meta?.requiredExtensions || {};
        return { 
            success: true, 
            versions: {
                codexEditor: versions.codexEditor,
                frontierAuthentication: versions.frontierAuthentication
            }
        };
    }
}
