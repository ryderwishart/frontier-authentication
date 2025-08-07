You're absolutely right - this is a **critical constraint** I overlooked. Since we're working entirely within VS Code using isomorphic-git, we can't use native `git lfs` commands. This changes everything but actually makes it simpler in some ways.

## **Revised Implementation with Isomorphic-Git Constraints**

### **Core Architecture**

- **No native Git LFS commands** - everything through `@riboseinc/isogit-lfs`
- **Pure Node.js/browser environment** within VS Code extension
- **Integrate with existing GitService.ts** that already uses isomorphic-git

## **Phase 1: LFS Service Integration (Week 1)**

### **1.1 Package Installation**

```json
// package.json additions
"dependencies": {
  "@riboseinc/isogit-lfs": "^0.2.0",
  "@aws-crypto/sha256-universal": "^2.0.0"
}
```

### **1.2 Create LFS Service**

```typescript
// src/git/LFSService.ts
import {
    pointsToLFS,
    readPointer,
    downloadBlobFromPointer,
    uploadBlob,
} from "@riboseinc/isogit-lfs";
import * as git from "isomorphic-git";

export class LFSService {
    // Default patterns based on your requirements
    private static DEFAULT_LFS_PATTERNS = [
        "*.webm",
        "*.mp4",
        "*.mov",
        "*.avi",
        "*.mkv",
        "*.wmv",
        "*.flv",
        "*.mp3",
        "*.wav",
        "*.flac",
        "*.ogg",
        "*.m4a",
        "*.aac",
        "*.jpg",
        "*.jpeg",
        "*.png",
        "*.gif",
        "*.bmp",
        "*.tiff",
        "*.webp",
        "*.psd",
        "*.ai",
        "*.svg",
        "*.eps",
        "*.pdf",
        "*.doc",
        "*.docx",
        "*.ppt",
        "*.pptx",
        "*.zip",
        "*.rar",
        "*.7z",
        "*.tar.gz",
    ];

    private static SIZE_THRESHOLD = 15 * 1024 * 1024; // 15MB

    async shouldUseLFS(filepath: string, fileSize: number): Promise<boolean> {
        // Never use LFS for JSON files regardless of size
        if (filepath.endsWith(".json")) {
            return false;
        }

        // Check if file matches LFS patterns
        const matchesPattern = this.matchesLFSPattern(filepath);

        // Use LFS if matches pattern OR exceeds size threshold
        return matchesPattern || fileSize > LFSService.SIZE_THRESHOLD;
    }

    private matchesLFSPattern(filepath: string): boolean {
        const filename = filepath.toLowerCase();
        return LFSService.DEFAULT_LFS_PATTERNS.some((pattern) => {
            const regex = new RegExp(pattern.replace("*", ".*"));
            return regex.test(filename);
        });
    }
}
```

### **1.3 Modify GitService Integration**

```typescript
// Modify src/git/GitService.ts
import { LFSService } from "./LFSService";

export class GitService {
    private lfsService: LFSService;

    constructor(stateManager: StateManager) {
        // ... existing code ...
        this.lfsService = new LFSService();
    }

    // Override readBlob to handle LFS pointers
    async readBlobWithLFS(
        fs: any,
        dir: string,
        oid: string,
        filepath: string
    ): Promise<Uint8Array> {
        const gitObject = await git.readBlob({ fs, dir, oid, filepath });

        if (pointsToLFS(gitObject.blob)) {
            const pointer = readPointer({
                gitdir: path.join(dir, ".git"),
                content: gitObject.blob,
            });

            const remoteURL = await this.getRemoteUrl(dir);
            return await downloadBlobFromPointer(
                {
                    fs,
                    url: remoteURL,
                    http,
                },
                pointer
            );
        }

        return gitObject.blob;
    }
}
```

## **Phase 2: Auto-Initialize LFS (Week 1)**

### **2.1 LFS Initialization Command**

```typescript
// Add to src/commands/gitlabCommands.ts or create new LFS commands file
export function registerLFSCommands(context: vscode.ExtensionContext, gitService: GitService) {
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.initializeLFS", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            await gitService.initializeLFS(workspacePath);
            vscode.window.showInformationMessage("LFS initialized for multimedia files");
        })
    );
}
```

### **2.2 Auto-Initialize on New Repos**

```typescript
// In GitService.ts
async initializeLFS(dir: string): Promise<void> {
    const gitattributesPath = path.join(dir, '.gitattributes');

    // Create .gitattributes with LFS patterns
    const lfsPatterns = [
        '# Multimedia files',
        '*.webm filter=lfs diff=lfs merge=lfs -text',
        '*.mp4 filter=lfs diff=lfs merge=lfs -text',
        '*.mov filter=lfs diff=lfs merge=lfs -text',
        // ... all patterns
        '',
        '# Large files over 15MB (except JSON)',
        '# Add specific large files manually as needed'
    ].join('\n');

    await fs.promises.writeFile(gitattributesPath, lfsPatterns, 'utf8');
    await this.add(dir, '.gitattributes');
    await this.commit(dir, 'Initialize Git LFS for multimedia files', {
        name: 'System',
        email: 'system@frontier.com'
    });
}
```

## **Phase 3: Migration Modal (Week 2)**

### **3.1 Migration Detection & Modal**

```typescript
// In SCMManager.ts or new LFS manager
async checkForLargFiles(dir: string): Promise<string[]> {
    const status = await this.gitService.getStatus(dir);
    const largeFiles: string[] = [];

    for (const [filepath] of status) {
        try {
            const fullPath = path.join(dir, filepath);
            const stats = await fs.promises.stat(fullPath);

            if (await this.lfsService.shouldUseLFS(filepath, stats.size)) {
                largeFiles.push(filepath);
            }
        } catch (error) {
            // File might not exist, skip
        }
    }

    return largeFiles;
}

async promptForMigration(largeFiles: string[]): Promise<boolean> {
    const message = `Found ${largeFiles.length} large multimedia files that could benefit from Git LFS. Would you like to migrate them?`;

    const choice = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        "Yes, migrate files",
        "No, leave as regular Git files"
    );

    return choice === "Yes, migrate files";
}
```

### **3.2 Isomorphic-Git Migration Process**

```typescript
// Since we can't use `git lfs migrate`, we implement our own
async migrateFilesToLFS(dir: string, files: string[]): Promise<void> {
    for (const filepath of files) {
        // Remove from git index but keep file
        await git.remove({ fs, dir, filepath });

        // Add back - now it will be tracked as LFS due to .gitattributes
        await git.add({ fs, dir, filepath });
    }

    await this.commit(dir, `Migrate ${files.length} files to Git LFS`, {
        name: 'System',
        email: 'system@frontier.com'
    });
}
```

## **Phase 4: Size-Based Suggestions (Week 2)**

### **4.1 File Size Monitoring**

```typescript
// In file watcher or during add operations
async checkFileSizeAndSuggestLFS(filepath: string): Promise<void> {
    const stats = await fs.promises.stat(filepath);

    // Skip JSON files
    if (filepath.endsWith('.json')) {
        return;
    }

    if (stats.size > 15 * 1024 * 1024) { // 15MB
        const choice = await vscode.window.showWarningMessage(
            `File ${path.basename(filepath)} is ${Math.round(stats.size / 1024 / 1024)}MB. Consider using Git LFS?`,
            "Add to LFS patterns",
            "Keep as regular file"
        );

        if (choice === "Add to LFS patterns") {
            await this.addToLFSPatterns(filepath);
        }
    }
}
```

## **Critical Implementation Notes**

### **1. No Native Git Commands**

- Everything goes through isomorphic-git APIs
- LFS operations use `@riboseinc/isogit-lfs` exclusively
- File system operations use Node.js `fs` API

### **2. .gitattributes Management**

- We manage this file directly through file system writes
- Must be committed to repository for LFS to work
- Patterns determine what gets tracked as LFS

### **3. Migration Strategy**

- Remove files from git index with `git.remove()`
- Re-add with `git.add()` - now tracked as LFS
- Much simpler than native `git lfs migrate`

### **4. User Experience**

- Auto-initialize LFS on new repos ✓
- One-time migration modal for existing repos ✓
- Size-based suggestions (15MB, no JSON) ✓
- All multimedia patterns tracked by default ✓

This approach respects the isomorphic-git constraint while keeping the implementation straightforward. The key insight is that LFS tracking is determined by `.gitattributes` patterns, so we just need to manage that file and let isomorphic-git + isogit-lfs handle the rest.

# Git LFS Implementation TODO List

## **Phase 1: Foundation & Setup**

### ✅ **1.1 Package Dependencies**

```json
// package.json - Add to dependencies section
{
    "@riboseinc/isogit-lfs": "^0.2.0",
    "@aws-crypto/sha256-universal": "^2.0.0"
}
```

**Requirements:**

- Must work in VS Code extension environment
- No native git dependencies
- Compatible with existing isomorphic-git setup

**Self-Critique:** ✅ Good - these are the only LFS packages that work with isomorphic-git

---

### 🔲 **1.2 Create LFS Service Module**

```typescript
// src/git/LFSService.ts
import {
    pointsToLFS,
    readPointer,
    downloadBlobFromPointer,
    uploadBlob,
} from "@riboseinc/isogit-lfs";
import * as git from "isomorphic-git";
import * as fs from "fs";
import * as path from "path";

export class LFSService {
    // REQUIREMENT: Default multimedia patterns
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
        // Audio formats
        "*.mp3",
        "*.wav",
        "*.flac",
        "*.ogg",
        "*.m4a",
        "*.aac",
        "*.wma",
        // Image formats
        "*.jpg",
        "*.jpeg",
        "*.png",
        "*.gif",
        "*.bmp",
        "*.tiff",
        "*.webp",
        "*.raw",
        // Design files
        "*.psd",
        "*.ai",
        "*.sketch",
        "*.fig",
        // Documents (large ones)
        "*.pdf",
        "*.doc",
        "*.docx",
        "*.ppt",
        "*.pptx",
        // Archives
        "*.zip",
        "*.rar",
        "*.7z",
        "*.tar.gz",
        "*.dmg",
        "*.iso",
    ];

    // REQUIREMENT: 15MB threshold, never JSON
    private static readonly SIZE_THRESHOLD = 15 * 1024 * 1024; // 15MB
    private static readonly EXCLUDED_EXTENSIONS = [".json", ".jsonc"];

    /**
     * REQUIREMENT: Determine if file should use LFS based on pattern or size
     * Must exclude JSON files regardless of size
     */
    async shouldUseLFS(filepath: string, fileSize: number): Promise<boolean> {
        // REQUIREMENT: Never use LFS for JSON files regardless of size
        const ext = path.extname(filepath).toLowerCase();
        if (this.EXCLUDED_EXTENSIONS.includes(ext)) {
            return false;
        }

        // Check pattern match OR size threshold
        return this.matchesLFSPattern(filepath) || fileSize > LFSService.SIZE_THRESHOLD;
    }

    /**
     * Check if file matches predefined LFS patterns
     */
    private matchesLFSPattern(filepath: string): boolean {
        const filename = path.basename(filepath).toLowerCase();
        return LFSService.DEFAULT_LFS_PATTERNS.some((pattern) => {
            // Convert glob pattern to regex
            const regexPattern = pattern.replace(/\*/g, ".*").replace(/\./g, "\\.");
            return new RegExp(`^${regexPattern}$`).test(filename);
        });
    }

    /**
     * REQUIREMENT: Read blob and handle LFS pointers transparently
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
            const pointer = readPointer({
                gitdir: path.join(dir, ".git"),
                content: gitObject.blob,
            });

            // Get remote URL for LFS endpoint
            const remoteURL = await git.getConfig({ fs, dir, path: "remote.origin.url" });
            if (!remoteURL) {
                throw new Error("No remote origin configured for LFS download");
            }

            // Download actual file content
            return await downloadBlobFromPointer(
                {
                    fs,
                    url: remoteURL,
                    http,
                    ...(auth && { auth }),
                },
                pointer
            );
        }

        return gitObject.blob;
    }

    /**
     * Generate .gitattributes content with LFS patterns
     */
    generateGitAttributes(): string {
        const patterns = [
            "# Git LFS Configuration - Multimedia Files",
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
            "",
            "# Audio Files",
            "*.mp3 filter=lfs diff=lfs merge=lfs -text",
            "*.wav filter=lfs diff=lfs merge=lfs -text",
            "*.flac filter=lfs diff=lfs merge=lfs -text",
            "*.ogg filter=lfs diff=lfs merge=lfs -text",
            "*.m4a filter=lfs diff=lfs merge=lfs -text",
            "*.aac filter=lfs diff=lfs merge=lfs -text",
            "*.wma filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Image Files",
            "*.jpg filter=lfs diff=lfs merge=lfs -text",
            "*.jpeg filter=lfs diff=lfs merge=lfs -text",
            "*.png filter=lfs diff=lfs merge=lfs -text",
            "*.gif filter=lfs diff=lfs merge=lfs -text",
            "*.bmp filter=lfs diff=lfs merge=lfs -text",
            "*.tiff filter=lfs diff=lfs merge=lfs -text",
            "*.webp filter=lfs diff=lfs merge=lfs -text",
            "*.raw filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Design Files",
            "*.psd filter=lfs diff=lfs merge=lfs -text",
            "*.ai filter=lfs diff=lfs merge=lfs -text",
            "*.sketch filter=lfs diff=lfs merge=lfs -text",
            "*.fig filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Documents (Large)",
            "*.pdf filter=lfs diff=lfs merge=lfs -text",
            "*.doc filter=lfs diff=lfs merge=lfs -text",
            "*.docx filter=lfs diff=lfs merge=lfs -text",
            "*.ppt filter=lfs diff=lfs merge=lfs -text",
            "*.pptx filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Archives",
            "*.zip filter=lfs diff=lfs merge=lfs -text",
            "*.rar filter=lfs diff=lfs merge=lfs -text",
            "*.7z filter=lfs diff=lfs merge=lfs -text",
            "*.tar.gz filter=lfs diff=lfs merge=lfs -text",
            "*.dmg filter=lfs diff=lfs merge=lfs -text",
            "*.iso filter=lfs diff=lfs merge=lfs -text",
            "",
            "# Note: Files over 15MB will be suggested for LFS (except .json files)",
            "# Add large files manually to this list as needed",
        ];

        return patterns.join("\n") + "\n";
    }
}
```

**Self-Critique:**

- ❌ **Issue**: The `readBlobWithLFS` method has too many parameters - should integrate better with existing GitService
- ❌ **Issue**: Error handling is basic - need better error messages for users
- ✅ **Good**: Covers all multimedia types and respects JSON exclusion
- ❌ **Issue**: No caching strategy for LFS downloads - could be slow

---

### 🔲 **1.3 Integrate LFS into GitService**

```typescript
// Modify src/git/GitService.ts
import { LFSService } from "./LFSService";

export class GitService {
    private lfsService: LFSService;
    private lfsEnabled: boolean = false;

    constructor(stateManager: StateManager) {
        // ... existing code ...
        this.lfsService = new LFSService();
    }

    /**
     * REQUIREMENT: Auto-initialize LFS on new repos
     */
    async initializeLFS(dir: string, author: { name: string; email: string }): Promise<void> {
        try {
            const gitattributesPath = path.join(dir, ".gitattributes");
            const lfsConfig = this.lfsService.generateGitAttributes();

            // Write .gitattributes file
            await fs.promises.writeFile(gitattributesPath, lfsConfig, "utf8");

            // Add and commit .gitattributes
            await this.add(dir, ".gitattributes");
            await this.commit(dir, "Initialize Git LFS for multimedia files", author);

            this.lfsEnabled = true;
            console.log("[GitService] LFS initialized successfully");
        } catch (error) {
            console.error("[GitService] Failed to initialize LFS:", error);
            throw new Error(
                `Failed to initialize Git LFS: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    /**
     * Check if repository has LFS enabled
     */
    async isLFSEnabled(dir: string): Promise<boolean> {
        try {
            const gitattributesPath = path.join(dir, ".gitattributes");
            const exists = await fs.promises
                .access(gitattributesPath)
                .then(() => true)
                .catch(() => false);
            if (!exists) return false;

            const content = await fs.promises.readFile(gitattributesPath, "utf8");
            return content.includes("filter=lfs");
        } catch (error) {
            return false;
        }
    }

    /**
     * REQUIREMENT: Override readBlob to handle LFS transparently
     */
    async readBlob(
        fs: any,
        dir: string,
        oid: string,
        filepath: string
    ): Promise<{ blob: Uint8Array; oid: string }> {
        // First try standard git readBlob
        const gitObject = await git.readBlob({ fs, dir, oid, filepath });

        // If LFS is enabled and this is a pointer file, resolve it
        if (this.lfsEnabled || (await this.isLFSEnabled(dir))) {
            try {
                const actualBlob = await this.lfsService.readBlobWithLFS(
                    fs,
                    dir,
                    oid,
                    filepath,
                    http
                    // TODO: Get auth from current session
                );
                return { blob: actualBlob, oid: gitObject.oid };
            } catch (lfsError) {
                console.warn("[GitService] LFS read failed, falling back to pointer:", lfsError);
                return gitObject;
            }
        }

        return gitObject;
    }

    // REQUIREMENT: Override addAll to check for LFS candidates
    async addAll(dir: string): Promise<void> {
        const status = await git.statusMatrix({ fs, dir });
        const lfsEnabled = await this.isLFSEnabled(dir);

        // Handle deletions first (existing logic)
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

        // REQUIREMENT: Check file sizes and suggest LFS for large files
        for (const filepath of modifiedFiles) {
            if (lfsEnabled) {
                await this.checkAndSuggestLFS(dir, filepath);
            }
            await git.add({ fs, dir, filepath });
        }
    }

    /**
     * REQUIREMENT: Check file size and suggest LFS (15MB threshold, no JSON)
     */
    private async checkAndSuggestLFS(dir: string, filepath: string): Promise<void> {
        try {
            const fullPath = path.join(dir, filepath);
            const stats = await fs.promises.stat(fullPath);

            if (await this.lfsService.shouldUseLFS(filepath, stats.size)) {
                // Don't suggest if already tracked by .gitattributes patterns
                if (!this.lfsService.matchesLFSPattern(filepath)) {
                    // This is a large file (>15MB) not covered by patterns
                    vscode.window
                        .showWarningMessage(
                            `File ${path.basename(filepath)} is ${Math.round(stats.size / 1024 / 1024)}MB. Consider adding its type to Git LFS patterns?`,
                            "Add Pattern",
                            "Ignore"
                        )
                        .then((choice) => {
                            if (choice === "Add Pattern") {
                                this.addFileTypeToLFS(dir, filepath);
                            }
                        });
                }
            }
        } catch (error) {
            // File might not exist or be accessible, skip suggestion
            console.debug("[GitService] Could not check file for LFS suggestion:", filepath, error);
        }
    }

    /**
     * Add file type to LFS patterns in .gitattributes
     */
    private async addFileTypeToLFS(dir: string, filepath: string): Promise<void> {
        try {
            const ext = path.extname(filepath);
            if (!ext) return;

            const gitattributesPath = path.join(dir, ".gitattributes");
            const newPattern = `*${ext} filter=lfs diff=lfs merge=lfs -text\n`;

            await fs.promises.appendFile(gitattributesPath, newPattern, "utf8");

            // Add and commit the updated .gitattributes
            await this.add(dir, ".gitattributes");
            // Note: Don't auto-commit here, let it be part of user's next commit

            vscode.window.showInformationMessage(`Added ${ext} files to Git LFS patterns`);
        } catch (error) {
            console.error("[GitService] Failed to add file type to LFS:", error);
            vscode.window.showErrorMessage(
                `Failed to add file type to LFS: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }
}
```

**Self-Critique:**

- ❌ **Major Issue**: The `readBlob` override will break existing code that expects the original signature
- ❌ **Issue**: LFS authentication is not handled - need to integrate with existing auth system
- ❌ **Issue**: No error recovery if LFS server is down
- ✅ **Good**: Integrates with existing file watching and status logic
- ❌ **Issue**: The LFS suggestion popup could be annoying - need better UX

---

## **Phase 2: Commands & User Interface**

### 🔲 **2.1 LFS Commands**

```typescript
// src/commands/lfsCommands.ts
import * as vscode from "vscode";
import { GitService } from "../git/GitService";
import { GitLabService } from "../gitlab/GitLabService";

export function registerLFSCommands(
    context: vscode.ExtensionContext,
    gitService: GitService,
    gitLabService: GitLabService
) {
    // REQUIREMENT: Auto-initialize LFS on new repos
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.initializeLFS", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            try {
                // Get user info for commit
                const userInfo = await gitLabService.getUserInfo();
                await gitService.initializeLFS(workspacePath, {
                    name: userInfo.username,
                    email: userInfo.email,
                });

                vscode.window.showInformationMessage(
                    "✅ Git LFS initialized! Multimedia files will now be stored efficiently."
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to initialize LFS: ${error instanceof Error ? error.message : "Unknown error"}`
                );
            }
        })
    );

    // REQUIREMENT: Optional migration for existing repos
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.migrateLargeFiles", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            try {
                const largeFiles = await findLargeFiles(workspacePath, gitService);

                if (largeFiles.length === 0) {
                    vscode.window.showInformationMessage(
                        "No large files found that would benefit from LFS"
                    );
                    return;
                }

                // REQUIREMENT: Use modal to ask about migration
                const fileList =
                    largeFiles.slice(0, 5).join("\n• ") +
                    (largeFiles.length > 5 ? `\n• ... and ${largeFiles.length - 5} more` : "");

                const choice = await vscode.window.showInformationMessage(
                    `Found ${largeFiles.length} large files that could benefit from Git LFS:\n\n• ${fileList}\n\nMigrate these files to LFS?`,
                    { modal: true },
                    "Yes, migrate files",
                    "No, leave as regular Git files"
                );

                if (choice === "Yes, migrate files") {
                    await migrateFilesToLFS(workspacePath, largeFiles, gitService, gitLabService);
                    vscode.window.showInformationMessage(
                        `✅ Successfully migrated ${largeFiles.length} files to Git LFS`
                    );
                }
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Migration failed: ${error instanceof Error ? error.message : "Unknown error"}`
                );
            }
        })
    );

    // LFS Status Command
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.lfsStatus", async () => {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
                vscode.window.showErrorMessage("No workspace folder found");
                return;
            }

            try {
                const isEnabled = await gitService.isLFSEnabled(workspacePath);
                if (!isEnabled) {
                    const choice = await vscode.window.showInformationMessage(
                        "Git LFS is not enabled for this repository. Would you like to enable it?",
                        "Enable LFS",
                        "Cancel"
                    );

                    if (choice === "Enable LFS") {
                        await vscode.commands.executeCommand("frontier.initializeLFS");
                    }
                    return;
                }

                // Show LFS status info
                const status = await getLFSStatus(workspacePath, gitService);
                const message = `Git LFS Status:
                
✅ LFS Enabled
📁 Tracked patterns: ${status.trackedPatterns.length}
📄 LFS files: ${status.lfsFiles.length}
💾 Total LFS size: ${formatBytes(status.totalSize)}`;

                vscode.window.showInformationMessage(message);
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to get LFS status: ${error instanceof Error ? error.message : "Unknown error"}`
                );
            }
        })
    );
}

/**
 * Find files that should be migrated to LFS
 */
async function findLargeFiles(dir: string, gitService: GitService): Promise<string[]> {
    const status = await gitService.getStatus(dir);
    const largeFiles: string[] = [];

    for (const [filepath] of status) {
        try {
            const fullPath = path.join(dir, filepath);
            const stats = await fs.promises.stat(fullPath);

            // Use LFSService logic to determine if file should be in LFS
            if (await gitService["lfsService"].shouldUseLFS(filepath, stats.size)) {
                largeFiles.push(filepath);
            }
        } catch (error) {
            // File might not exist, skip
        }
    }

    return largeFiles;
}

/**
 * REQUIREMENT: Migrate files to LFS using isomorphic-git only
 */
async function migrateFilesToLFS(
    dir: string,
    files: string[],
    gitService: GitService,
    gitLabService: GitLabService
): Promise<void> {
    // Ensure LFS is initialized first
    const isEnabled = await gitService.isLFSEnabled(dir);
    if (!isEnabled) {
        const userInfo = await gitLabService.getUserInfo();
        await gitService.initializeLFS(dir, {
            name: userInfo.username,
            email: userInfo.email,
        });
    }

    // Remove files from git index but keep actual files
    for (const filepath of files) {
        await gitService.remove(dir, filepath);
    }

    // Add files back - now they'll be tracked as LFS due to .gitattributes
    for (const filepath of files) {
        await gitService.add(dir, filepath);
    }

    // Commit the migration
    const userInfo = await gitLabService.getUserInfo();
    await gitService.commit(
        dir,
        `Migrate ${files.length} large files to Git LFS\n\nFiles migrated:\n${files.map((f) => `• ${f}`).join("\n")}`,
        { name: userInfo.username, email: userInfo.email }
    );
}

// Helper functions
async function getLFSStatus(dir: string, gitService: GitService) {
    // TODO: Implement LFS status checking
    return {
        trackedPatterns: [],
        lfsFiles: [],
        totalSize: 0,
    };
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
```

**Self-Critique:**

- ✅ **Good**: Follows requirement for modal migration prompt
- ✅ **Good**: Auto-initializes LFS on new repos
- ❌ **Issue**: Migration is destructive - should warn users about history rewriting
- ❌ **Issue**: No progress indication for large migrations
- ✅ **Good**: Integrates with existing GitLab user info

---

### 🔲 **2.2 Update Package.json Commands**

```json
// package.json - Add to contributes.commands
{
    "command": "frontier.initializeLFS",
    "title": "Initialize Git LFS",
    "category": "Frontier"
},
{
    "command": "frontier.migrateLargeFiles",
    "title": "Migrate Large Files to LFS",
    "category": "Frontier"
},
{
    "command": "frontier.lfsStatus",
    "title": "Show Git LFS Status",
    "category": "Frontier"
}
```

---

## **Phase 3: Integration & Testing**

### 🔲 **3.1 Update Extension.ts**

```typescript
// src/extension.ts - Add LFS command registration
import { registerLFSCommands } from "./commands/lfsCommands";

export async function activate(context: vscode.ExtensionContext) {
    // ... existing code ...

    // Register LFS commands
    registerLFSCommands(context, scmManager.gitService, gitlabService);

    // REQUIREMENT: Auto-initialize LFS on new repos
    // Hook into repository creation/opening
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
        for (const folder of event.added) {
            const hasGit = await scmManager.gitService.hasGitRepository(folder.uri.fsPath);
            if (hasGit) {
                const isLFS = await scmManager.gitService.isLFSEnabled(folder.uri.fsPath);
                if (!isLFS) {
                    // Suggest LFS initialization for new repos
                    const choice = await vscode.window.showInformationMessage(
                        "This repository could benefit from Git LFS for multimedia files. Initialize LFS?",
                        "Yes",
                        "No",
                        "Don't ask again"
                    );

                    if (choice === "Yes") {
                        await vscode.commands.executeCommand("frontier.initializeLFS");
                    } else if (choice === "Don't ask again") {
                        // Store preference in workspace settings
                        await vscode.workspace
                            .getConfiguration("frontier")
                            .update("autoSuggestLFS", false);
                    }
                }
            }
        }
    });
}
```

**Self-Critique:**

- ✅ **Good**: Auto-suggests LFS on new repos
- ❌ **Issue**: The workspace change event might fire too often
- ✅ **Good**: Respects user preference to not ask again
- ❌ **Issue**: Should check if repo has multimedia files before suggesting

---

## **Overall Self-Critique & Concerns**

### **Major Issues to Address:**

1. **❌ Breaking Changes**: The `readBlob` override will break existing code
2. **❌ Authentication**: LFS auth integration with GitLab tokens not handled
3. **❌ Error Handling**: Need better user-facing error messages
4. **❌ Performance**: No caching strategy for LFS downloads
5. **❌ UX**: Too many popups could annoy users

### **Requirements Compliance:**

- ✅ **Isomorphic-git only**: No native git commands used
- ✅ **Auto-initialize on new repos**: Implemented
- ✅ **Optional migration modal**: Implemented
- ✅ **15MB threshold, no JSON**: Implemented
- ✅ **Common multimedia patterns**: Comprehensive list included

### **Next Steps Priority:**

1. **Fix breaking changes** in GitService integration
2. **Add proper authentication** handling for LFS operations
3. **Implement error recovery** for offline/server issues
4. **Add progress indicators** for long operations
5. **Test with real multimedia files** to validate approach

### **Estimated Timeline:**

- **Week 1**: Core LFS service + basic integration (Items 1.1-1.3)
- **Week 2**: Commands + UI + testing (Items 2.1-3.1)
- **Week 3**: Polish, error handling, performance optimization

The foundation is solid but needs refinement in integration points and user experience.
