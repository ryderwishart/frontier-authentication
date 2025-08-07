import { readPointer, downloadBlobFromPointer } from "@riboseinc/isogit-lfs";
import uploadBlob from "@riboseinc/isogit-lfs/upload";
import { formatPointerInfo, buildPointerInfo } from "@riboseinc/isogit-lfs/pointers";
import { pointsToLFS } from "@riboseinc/isogit-lfs/util.js";
import * as git from "isomorphic-git";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export interface LFSStatus {
    trackedPatterns: string[];
    lfsFiles: string[];
    totalSize: number;
}

export class LFSService {
    // Comprehensive multimedia patterns that should always use LFS
    private static readonly DEFAULT_LFS_PATTERNS = [
        // Video formats
        "*.webm",
        "*.mp4",
        "*.mov",
        "*.avi",
        "*.mkv",
        "*.wmv",
        "*.flv",
        "*.m4v",
        "*.3gp",
        "*.ogv",

        // Audio formats
        "*.mp3",
        "*.wav",
        "*.flac",
        "*.ogg",
        "*.m4a",
        "*.aac",
        "*.wma",
        "*.opus",
        "*.ac3",
        "*.dts",

        // Image formats (large/raw)
        "*.jpg",
        "*.jpeg",
        "*.png",
        "*.gif",
        "*.bmp",
        "*.tiff",
        "*.tif",
        "*.webp",
        "*.raw",
        "*.cr2",
        "*.nef",
        "*.dng",
        "*.heic",
        "*.heif",

        // Design files
        "*.psd",
        "*.ai",
        "*.sketch",
        "*.fig",
        "*.xd",
        "*.eps",
        "*.indd",

        // Documents (potentially large)
        "*.pdf",
        "*.doc",
        "*.docx",
        "*.ppt",
        "*.pptx",
        "*.xls",
        "*.xlsx",

        // Archives
        "*.zip",
        "*.rar",
        "*.7z",
        "*.tar.gz",
        "*.tar.bz2",
        "*.dmg",
        "*.iso",
        "*.pkg",
        "*.deb",
        "*.rpm",

        // 3D/CAD files
        "*.obj",
        "*.fbx",
        "*.dae",
        "*.3ds",
        "*.blend",
        "*.max",
        "*.dwg",
        "*.step",

        // Database files
        "*.db",
        "*.sqlite",
        "*.sqlite3",
        "*.mdb",
        "*.accdb",
    ];

    // 15MB threshold for any file (except excluded types)
    private static readonly SIZE_THRESHOLD = 15 * 1024 * 1024; // 15MB

    // File types that should NEVER use LFS regardless of size
    private static readonly EXCLUDED_EXTENSIONS = [
        ".json",
        ".jsonc",
        ".txt",
        ".md",
        ".yml",
        ".yaml",
        ".xml",
        ".html",
        ".css",
        ".js",
        ".ts",
        ".tsx",
        ".jsx",
        ".py",
        ".java",
        ".c",
        ".cpp",
        ".h",
        ".hpp",
        ".cs",
        ".php",
        ".rb",
        ".go",
        ".rs",
        ".swift",
        ".kt",
        ".sh",
        ".bat",
        ".ps1",
    ];

    /**
     * Determine if a file should use LFS based on pattern matching or size threshold
     * Excludes text/code files regardless of size
     */
    async shouldUseLFS(filepath: string, fileSize: number): Promise<boolean> {
        const ext = path.extname(filepath).toLowerCase();

        // Never use LFS for code/text files regardless of size
        if (LFSService.EXCLUDED_EXTENSIONS.includes(ext)) {
            return false;
        }

        // Always use LFS for multimedia files that match our patterns
        if (this.matchesLFSPattern(filepath)) {
            return true;
        }

        // Use LFS for any other file over the size threshold
        return fileSize > LFSService.SIZE_THRESHOLD;
    }

    /**
     * Check if file matches predefined LFS patterns
     */
    matchesLFSPattern(filepath: string): boolean {
        const filename = path.basename(filepath).toLowerCase();
        return LFSService.DEFAULT_LFS_PATTERNS.some((pattern) => {
            // Convert glob pattern to regex
            const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*");
            return new RegExp(`^${regexPattern}$`).test(filename);
        });
    }

    /**
     * Read blob and handle LFS pointers transparently
     */
    async readBlobWithLFS(
        fs: any,
        dir: string,
        oid: string,
        filepath: string,
        http: any,
        auth?: { username: string; password: string }
    ): Promise<Uint8Array> {
        const gitObject = await git.readBlob({ fs, dir, oid, filepath });

        // Check if this is an LFS pointer file
        if (pointsToLFS(gitObject.blob)) {
            try {
                const pointer = readPointer({
                    gitdir: path.join(dir, ".git"),
                    content: gitObject.blob,
                });

                // Get remote URL for LFS endpoint
                const remoteURL = await git.getConfig({ fs, dir, path: "remote.origin.url" });
                if (!remoteURL) {
                    throw new Error("No remote origin configured for LFS download");
                }

                // Clean the URL to remove any embedded credentials
                const cleanURL = remoteURL.replace(/^https?:\/\/[^@]*@/, "https://");

                // Download actual file content
                return await downloadBlobFromPointer(
                    {
                        fs,
                        url: cleanURL,
                        http,
                        ...(auth && { onAuth: () => auth }),
                    },
                    pointer
                );
            } catch (lfsError) {
                console.warn(
                    "[LFSService] Failed to download LFS file, returning pointer:",
                    lfsError
                );
                // Return the pointer content as fallback
                return gitObject.blob;
            }
        }

        return gitObject.blob;
    }

    /**
     * Upload a file to LFS and return pointer information
     * This follows the workflow from the seamless LFS integration document
     */
    async uploadFileToLFS(
        fs: any,
        filePath: string,
        remoteURL: string,
        http: any,
        auth?: { username: string; password: string }
    ): Promise<{ oid: string; size: number; pointer: Uint8Array }> {
        console.log(`[LFSService] Uploading file to LFS: ${filePath}`);

        const fileContent = await fs.promises.readFile(filePath);

        // Upload to LFS server and get pointer info
        // Clean the URL to remove any embedded credentials
        const cleanURL = remoteURL.replace(/^https?:\/\/[^@]*@/, "https://");
        console.log(`[LFSService] Using clean URL for LFS: ${cleanURL}`);
        console.log(`[LFSService] Auth object:`, auth ? "present" : "missing");

        try {
            // First, let's test if the LFS endpoint is reachable
            const lfsEndpoint = `${cleanURL}/info/lfs/objects/batch`;
            console.log(`[LFSService] Testing LFS endpoint: ${lfsEndpoint}`);

            const pointerInfo = await uploadBlob(
                {
                    http,
                    url: cleanURL,
                    ...(auth && { onAuth: () => auth }),
                },
                fileContent
            );

            // Generate pointer file content
            const pointerBlob = formatPointerInfo(pointerInfo);

            console.log(
                `[LFSService] Successfully uploaded file to LFS. OID: ${pointerInfo.oid}, Size: ${pointerInfo.size}`
            );

            return {
                oid: pointerInfo.oid,
                size: pointerInfo.size,
                pointer: pointerBlob,
            };
        } catch (uploadError: any) {
            console.error(`[LFSService] Detailed upload error:`, {
                message: uploadError?.message || "Unknown error",
                stack: uploadError?.stack || "No stack trace",
                url: cleanURL,
                hasAuth: !!auth,
                fileSize: fileContent.length,
                error: uploadError,
            });
            throw uploadError;
        }
    }

    /**
     * Test LFS server connectivity
     */
    async testLFSConnectivity(
        cleanURL: string,
        http: any,
        auth?: { username: string; password: string }
    ): Promise<boolean> {
        try {
            const lfsEndpoint = `${cleanURL}/info/lfs/objects/batch`;
            console.log(`[LFSService] Testing LFS endpoint connectivity: ${lfsEndpoint}`);

            // Make a simple request to test connectivity using the same auth pattern as isomorphic-git
            const headers: Record<string, string> = {
                "Content-Type": "application/vnd.git-lfs+json",
                Accept: "application/vnd.git-lfs+json",
            };

            // Apply authentication using the same pattern as isomorphic-git
            if (auth) {
                const authString = Buffer.from(`${auth.username}:${auth.password}`).toString(
                    "base64"
                );
                headers.Authorization = `Basic ${authString}`;
            }

            // Use global fetch instead of the isomorphic-git http client for simple connectivity test
            const response = await fetch(lfsEndpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    operation: "upload",
                    transfers: ["basic"],
                    objects: [],
                }),
            });

            console.log(`[LFSService] LFS endpoint test response status: ${response.status}`);
            return response.status === 200 || response.status === 422; // 422 is expected for empty objects array
        } catch (error) {
            console.error(`[LFSService] LFS connectivity test failed:`, error);
            return false;
        }
    }

    /**
     * Process a file for LFS upload and replace with pointer
     * This is the core workflow that should be called during git add
     */
    async processFileForLFS(
        fs: any,
        dir: string,
        filepath: string,
        http: any,
        auth?: { username: string; password: string }
    ): Promise<boolean> {
        try {
            const fullPath = path.join(dir, filepath);
            const stats = await fs.promises.stat(fullPath);

            // Check if file should use LFS
            if (!(await this.shouldUseLFS(filepath, stats.size))) {
                return false;
            }

            // Get remote URL
            const remoteURL = await git.getConfig({ fs, dir, path: "remote.origin.url" });
            if (!remoteURL) {
                console.warn("[LFSService] No remote origin configured, skipping LFS upload");
                return false;
            }

            // Clean the URL to remove any embedded credentials
            const cleanURL = remoteURL.replace(/^https?:\/\/[^@]*@/, "https://");

            console.log(
                `[LFSService] Processing file for LFS: ${filepath} (${Math.round(stats.size / 1024 / 1024)}MB)`
            );

            // Test LFS server connectivity first
            const isConnected = await this.testLFSConnectivity(cleanURL, http, auth);
            if (!isConnected) {
                console.error(`[LFSService] LFS server connectivity test failed for ${cleanURL}`);
                vscode.window.showWarningMessage(
                    `LFS server not accessible for ${path.basename(filepath)}. The file will be committed to Git normally. ` +
                        `To use LFS, ensure the repository has LFS enabled and you have proper access.`
                );
                return false;
            }

            // Upload file to LFS and get pointer
            const { pointer } = await this.uploadFileToLFS(fs, fullPath, cleanURL, http, auth);

            // Replace file content with pointer
            await fs.promises.writeFile(fullPath, pointer);

            console.log(`[LFSService] Successfully replaced ${filepath} with LFS pointer`);

            // Show notification to user
            vscode.window.showInformationMessage(
                `🚀 Successfully processed ${path.basename(filepath)} for Git LFS (${Math.round(stats.size / 1024 / 1024)}MB)`
            );

            return true;
        } catch (error) {
            console.error(`[LFSService] Failed to process file for LFS: ${filepath}`, error);
            return false;
        }
    }

    /**
     * Generate .gitattributes content with all LFS patterns
     */
    generateGitAttributes(): string {
        const sections = [
            "# Git LFS Configuration - Multimedia and Large Files",
            "# Generated by Frontier Authentication Extension",
            "",
            "# Video Files",
            "*.webm filter=lfs diff=lfs merge=lfs -text",
            "*.mp4 filter=lfs diff=lfs merge=lfs -text",
            "*.mov filter=lfs diff=lfs merge=lfs -text",
            "*.avi filter=lfs diff=lfs merge=lfs -text",
            "*.mkv filter=lfs diff=lfs merge=lfs -text",
            "*.wmv filter=lfs diff=lfs merge=lfs -text",
            "*.flv filter=lfs diff=lfs merge=lfs -text",
            "*.m4v filter=lfs diff=lfs merge=lfs -text",
            "*.3gp filter=lfs diff=lfs merge=lfs -text",
            "*.ogv filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Audio Files",
            "*.mp3 filter=lfs diff=lfs merge=lfs -text",
            "*.wav filter=lfs diff=lfs merge=lfs -text",
            "*.flac filter=lfs diff=lfs merge=lfs -text",
            "*.ogg filter=lfs diff=lfs merge=lfs -text",
            "*.m4a filter=lfs diff=lfs merge=lfs -text",
            "*.aac filter=lfs diff=lfs merge=lfs -text",
            "*.wma filter=lfs diff=lfs merge=lfs -text",
            "*.opus filter=lfs diff=lfs merge=lfs -text",
            "*.ac3 filter=lfs diff=lfs merge=lfs -text",
            "*.dts filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Image Files",
            "*.jpg filter=lfs diff=lfs merge=lfs -text",
            "*.jpeg filter=lfs diff=lfs merge=lfs -text",
            "*.png filter=lfs diff=lfs merge=lfs -text",
            "*.gif filter=lfs diff=lfs merge=lfs -text",
            "*.bmp filter=lfs diff=lfs merge=lfs -text",
            "*.tiff filter=lfs diff=lfs merge=lfs -text",
            "*.tif filter=lfs diff=lfs merge=lfs -text",
            "*.webp filter=lfs diff=lfs merge=lfs -text",
            "*.raw filter=lfs diff=lfs merge=lfs -text",
            "*.cr2 filter=lfs diff=lfs merge=lfs -text",
            "*.nef filter=lfs diff=lfs merge=lfs -text",
            "*.dng filter=lfs diff=lfs merge=lfs -text",
            "*.heic filter=lfs diff=lfs merge=lfs -text",
            "*.heif filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Design Files",
            "*.psd filter=lfs diff=lfs merge=lfs -text",
            "*.ai filter=lfs diff=lfs merge=lfs -text",
            "*.sketch filter=lfs diff=lfs merge=lfs -text",
            "*.fig filter=lfs diff=lfs merge=lfs -text",
            "*.xd filter=lfs diff=lfs merge=lfs -text",
            "*.eps filter=lfs diff=lfs merge=lfs -text",
            "*.indd filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Documents",
            "*.pdf filter=lfs diff=lfs merge=lfs -text",
            "*.doc filter=lfs diff=lfs merge=lfs -text",
            "*.docx filter=lfs diff=lfs merge=lfs -text",
            "*.ppt filter=lfs diff=lfs merge=lfs -text",
            "*.pptx filter=lfs diff=lfs merge=lfs -text",
            "*.xls filter=lfs diff=lfs merge=lfs -text",
            "*.xlsx filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Archives",
            "*.zip filter=lfs diff=lfs merge=lfs -text",
            "*.rar filter=lfs diff=lfs merge=lfs -text",
            "*.7z filter=lfs diff=lfs merge=lfs -text",
            "*.tar.gz filter=lfs diff=lfs merge=lfs -text",
            "*.tar.bz2 filter=lfs diff=lfs merge=lfs -text",
            "*.dmg filter=lfs diff=lfs merge=lfs -text",
            "*.iso filter=lfs diff=lfs merge=lfs -text",
            "*.pkg filter=lfs diff=lfs merge=lfs -text",
            "*.deb filter=lfs diff=lfs merge=lfs -text",
            "*.rpm filter=lfs diff=lfs merge=lfs -text",
            "",
            "# 3D/CAD Files",
            "*.obj filter=lfs diff=lfs merge=lfs -text",
            "*.fbx filter=lfs diff=lfs merge=lfs -text",
            "*.dae filter=lfs diff=lfs merge=lfs -text",
            "*.3ds filter=lfs diff=lfs merge=lfs -text",
            "*.blend filter=lfs diff=lfs merge=lfs -text",
            "*.max filter=lfs diff=lfs merge=lfs -text",
            "*.dwg filter=lfs diff=lfs merge=lfs -text",
            "*.step filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Database Files",
            "*.db filter=lfs diff=lfs merge=lfs -text",
            "*.sqlite filter=lfs diff=lfs merge=lfs -text",
            "*.sqlite3 filter=lfs diff=lfs merge=lfs -text",
            "*.mdb filter=lfs diff=lfs merge=lfs -text",
            "*.accdb filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Note: Files over 15MB will be automatically suggested for LFS",
            "# (except code/text files which are excluded)",
            "# Add additional patterns manually as needed",
        ];

        return sections.join("\n") + "\n";
    }

    /**
     * Check if repository has LFS enabled by looking for .gitattributes
     */
    async isLFSEnabled(dir: string): Promise<boolean> {
        try {
            const gitattributesPath = path.join(dir, ".gitattributes");
            const exists = await fs.promises
                .access(gitattributesPath)
                .then(() => true)
                .catch(() => false);

            if (!exists) {
                return false;
            }

            const content = await fs.promises.readFile(gitattributesPath, "utf8");
            return content.includes("filter=lfs");
        } catch (error) {
            return false;
        }
    }

    /**
     * Get LFS status for a repository
     */
    async getLFSStatus(dir: string): Promise<LFSStatus> {
        const status: LFSStatus = {
            trackedPatterns: [],
            lfsFiles: [],
            totalSize: 0,
        };

        try {
            // Read .gitattributes to get tracked patterns
            const gitattributesPath = path.join(dir, ".gitattributes");
            const exists = await fs.promises
                .access(gitattributesPath)
                .then(() => true)
                .catch(() => false);

            if (exists) {
                const content = await fs.promises.readFile(gitattributesPath, "utf8");
                const lines = content.split("\n");

                for (const line of lines) {
                    if (line.includes("filter=lfs")) {
                        const pattern = line.split(" ")[0];
                        if (pattern && !pattern.startsWith("#")) {
                            status.trackedPatterns.push(pattern);
                        }
                    }
                }
            }

            // Find LFS files in the repository
            const gitdir = path.join(dir, ".git");
            const files = await git.listFiles({ fs, dir });

            for (const filepath of files) {
                try {
                    const oid = await git.resolveRef({ fs, dir, ref: `HEAD:${filepath}` });
                    const { blob } = await git.readBlob({ fs, dir, oid, filepath });

                    if (pointsToLFS(blob)) {
                        status.lfsFiles.push(filepath);

                        // Try to get size from pointer
                        try {
                            const pointer = readPointer({
                                gitdir,
                                content: blob,
                            });
                            status.totalSize += pointer.info.size;
                        } catch (error) {
                            // Could not read pointer size, skip
                        }
                    }
                } catch (error) {
                    // File might not exist or be readable, skip
                }
            }
        } catch (error) {
            console.warn("[LFSService] Failed to get LFS status:", error);
        }

        return status;
    }

    /**
     * Add a file extension to LFS patterns in .gitattributes
     */
    async addFileTypeToLFS(dir: string, filepath: string): Promise<void> {
        const ext = path.extname(filepath);
        if (!ext) {
            throw new Error("File has no extension");
        }

        const gitattributesPath = path.join(dir, ".gitattributes");
        const pattern = `*${ext} filter=lfs diff=lfs merge=lfs -text`;

        // Check if pattern already exists
        let content = "";
        try {
            content = await fs.promises.readFile(gitattributesPath, "utf8");
            if (content.includes(pattern)) {
                return; // Pattern already exists
            }
        } catch (error) {
            // File doesn't exist, will be created
        }

        // Add pattern to file
        const newContent = content + (content ? "\n" : "") + pattern + "\n";
        await fs.promises.writeFile(gitattributesPath, newContent, "utf8");
    }
}
