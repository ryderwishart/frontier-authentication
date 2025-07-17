import * as vscode from "vscode";
import * as path from "path";
import { ConflictedFile, GitService } from "../git/GitService";
import { GitLabService } from "../gitlab/GitLabService";
import * as git from "isomorphic-git";
import { PublishWorkspaceOptions } from "../commands/scmCommands";
import { StateManager } from "../state";
import { ResolvedFile } from "../extension";

export class SCMManager {
    private scmProvider: vscode.SourceControl;
    private workingTree: vscode.SourceControlResourceGroup;
    private staging: vscode.SourceControlResourceGroup;
    private fileSystemWatcher: vscode.FileSystemWatcher | undefined;
    public gitService: GitService;
    private gitLabService: GitLabService;
    private autoSyncEnabled: boolean = false;
    private autoSyncInterval: NodeJS.Timeout | undefined;
    private gitIgnorePatterns: string[] = [];
    private readonly context: vscode.ExtensionContext;
    private stateManager: StateManager;
    private syncStatusBarItem: vscode.StatusBarItem | undefined;

    constructor(gitLabService: GitLabService, context: vscode.ExtensionContext) {
        this.context = context;
        this.stateManager = StateManager.getInstance();
        this.gitService = new GitService(this.stateManager);
        this.gitLabService = gitLabService;

        // We'll initialize the SCM provider when we have a workspace
        this.scmProvider = vscode.scm.createSourceControl("frontier", "Frontier SCM");

        // Initialize resource groups
        this.workingTree = this.scmProvider.createResourceGroup("working", "Working Tree");
        this.staging = this.scmProvider.createResourceGroup("staging", "Staged Changes");

        // Set up input box for commit messages
        this.scmProvider.inputBox.placeholder = "Enter commit message";

        // Register sync commands
        this.registerCommands();

        // Automatically check and fix LFS setup when workspace is available
        this.autoFixLFSOnStartup();
    }

    /**
     * Automatically fix LFS setup when extension starts up
     */
    private async autoFixLFSOnStartup(): Promise<void> {
        // Check if auto-fix is enabled
        const autoFixEnabled = vscode.workspace
            .getConfiguration("frontier")
            .get("autoFixLFS", true);
        if (!autoFixEnabled) {
            return;
        }

        // Wait a bit for workspace to be fully loaded
        setTimeout(async () => {
            try {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    return;
                }

                const workspacePath = workspaceFolder.uri.fsPath;

                // Check if this is a git repository
                const hasGit = await this.gitService.hasGitRepository(workspacePath);
                if (!hasGit) {
                    return;
                }

                // Check if we need to fix LFS
                const needsLFSFix = await this.checkIfLFSFixNeeded(workspacePath);
                if (needsLFSFix) {
                    console.log("Detected LFS conflicts in .gitignore, auto-fixing...");

                    // Show a non-intrusive notification if enabled
                    const notifyEnabled = vscode.workspace
                        .getConfiguration("frontier")
                        .get("notifyLFSConflicts", true);
                    if (notifyEnabled) {
                        vscode.window
                            .showInformationMessage(
                                "Detected multimedia files in .gitignore. Enabling Git LFS tracking...",
                                "Learn More"
                            )
                            .then((selection) => {
                                if (selection === "Learn More") {
                                    vscode.env.openExternal(
                                        vscode.Uri.parse("https://git-lfs.github.io/")
                                    );
                                }
                            });
                    }

                    // Fix the LFS setup
                    await this.setupLFSAndFixGitIgnore(workspacePath);

                    // Commit the changes if there are any and auto-commit is enabled
                    const autoCommitEnabled = vscode.workspace
                        .getConfiguration("frontier")
                        .get("autoCommitLFSFixes", true);
                    if (autoCommitEnabled) {
                        await this.commitLFSFixChanges(workspacePath);
                    }
                }
            } catch (error) {
                console.error("Error in auto LFS fix:", error);
                // Don't show error to user for automatic fixes
            }
        }, 2000);
    }

    /**
     * Check if LFS fix is needed by examining .gitignore
     */
    private async checkIfLFSFixNeeded(workspacePath: string): Promise<boolean> {
        try {
            const gitIgnorePath = path.join(workspacePath, ".gitignore");
            const gitIgnoreUri = vscode.Uri.file(gitIgnorePath);

            try {
                const fileContent = await vscode.workspace.fs.readFile(gitIgnoreUri);
                const content = Buffer.from(fileContent).toString("utf8");

                // Check if any LFS patterns are in .gitignore
                const lfsPatterns = [
                    "*.mp4",
                    "*.avi",
                    "*.mov",
                    "*.wmv",
                    "*.webm",
                    "*.mp3",
                    "*.wav",
                    "*.jpg",
                    "*.jpeg",
                    "*.png",
                    "*.gif",
                    "*.psd",
                    "*.pdf",
                    "*.zip",
                    ".project/attachments/",
                ];

                const lines = content.split("\n").map((line) => line.trim());
                const hasLFSPatterns = lfsPatterns.some((pattern) => lines.includes(pattern));

                const hasLFSSection = lines.some((line) => line.includes("LFS-managed files"));

                // Need fix if we have LFS patterns but no LFS section
                return hasLFSPatterns && !hasLFSSection;
            } catch (error) {
                // .gitignore doesn't exist, no need to fix
                return false;
            }
        } catch (error) {
            console.error("Error checking LFS fix needed:", error);
            return false;
        }
    }

    /**
     * Commit LFS fix changes automatically
     */
    private async commitLFSFixChanges(workspacePath: string): Promise<void> {
        try {
            // Check if there are changes to commit
            const status = await this.gitService.getStatus(workspacePath);
            const hasChanges = status.some(
                ([_, head, workdir, stage]) => head !== workdir || head !== stage
            );

            if (!hasChanges) {
                return;
            }

            // Get auth and user info
            const token = await this.gitLabService.getToken();
            if (!token) {
                return; // Can't commit without auth
            }

            const user = await this.gitLabService.getCurrentUser();
            if (!user) {
                return;
            }

            const author = {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            };

            // Commit the LFS setup changes
            await this.gitService.addAll(workspacePath);
            await this.gitService.commit(
                workspacePath,
                "Auto-enable Git LFS for multimedia files and attachments",
                author
            );

            console.log("Auto-committed LFS setup changes");
        } catch (error) {
            console.error("Error committing LFS fix changes:", error);
            // Don't throw - this is automatic behavior
        }
    }

    private getWorkspacePath(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error("No workspace folder found");
        }
        const path = workspaceFolder.uri.fsPath;
        // console.log("Using workspace path:", path);
        return path;
    }

    private registerCommands(): void {
        // Manual sync command
        this.context.subscriptions.push(
            vscode.commands.registerCommand("frontier.syncChanges", () => this.syncChanges())
        );

        // Toggle auto-sync command
        this.context.subscriptions.push(
            vscode.commands.registerCommand("frontier.toggleAutoSync", () => this.toggleAutoSync())
        );

        // Commit changes command (used by SCM input box)
        this.context.subscriptions.push(
            vscode.commands.registerCommand("frontier.commitChanges", () => this.commitChanges())
        );

        this.context.subscriptions.push(
            vscode.commands.registerCommand(
                "frontier.completeMerge",
                (resolvedFiles: ResolvedFile[]) => this.completeMerge(resolvedFiles)
            )
        );
    }

    async createAndCloneProject(options: {
        name: string;
        description?: string;
        visibility?: "private" | "internal" | "public";
        groupId?: string;
        workspacePath?: string;
        path?: string;
    }): Promise<void> {
        try {
            // Initialize GitLab service and create project
            await this.gitLabService.initializeWithRetry();

            // Create the project
            const project = await this.gitLabService.createProject({
                name: options.name,
                description: options.description,
                visibility: options.visibility,
                groupId: options.groupId,
            });

            // Get workspace path
            let workspacePath = options.workspacePath;
            if (!workspacePath) {
                workspacePath = await this.promptForWorkspacePath(options.name);
            }
            if (!workspacePath) {
                throw new Error("No workspace path selected");
            }

            // Clone the repository using the token for authentication
            await this.cloneRepository(project.url, workspacePath);

            // Open the workspace
            await this.openWorkspace(workspacePath);

            // Initialize SCM
            await this.initializeSCM(workspacePath);

            const action = project.url.includes("already exists") ? "cloned" : "created and cloned";
            vscode.window.showInformationMessage(`Project ${options.name} ${action} successfully!`);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(
                    `Failed to create and clone project: ${error.message}`
                );
            }
            throw error;
        }
    }

    async cloneExistingRepository(repoUrl: string, cloneToPath?: string): Promise<void> {
        try {
            // Ensure GitLab service is initialized
            await this.gitLabService.initializeWithRetry();

            // Get GitLab credentials
            const gitlabToken = await this.gitLabService.getToken();
            if (!gitlabToken) {
                throw new Error("GitLab token not available");
            }

            // Extract project name from URL and construct authenticated URL
            const url = new URL(repoUrl);
            const projectName = url.pathname.split("/").pop()?.replace(".git", "") || "project";
            url.username = "oauth2";
            url.password = gitlabToken;

            // Get workspace path
            const workspacePath = cloneToPath || (await this.promptForWorkspacePath(projectName));
            if (!workspacePath) {
                throw new Error("No workspace path selected");
            }

            // Clone the repository
            await this.cloneRepository(url.toString(), workspacePath);

            // Open the workspace
            await this.openWorkspace(workspacePath);

            // Initialize SCM
            await this.initializeSCM(workspacePath);

            vscode.window.showInformationMessage("Repository cloned successfully!");
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to clone repository: ${error.message}`);
            }
            throw error;
        }
    }

    private async promptForWorkspacePath(defaultName: string): Promise<string | undefined> {
        vscode.window.showInformationMessage("Prompting for workspace path");
        // Use the default downloads directory or home directory
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        const defaultUri = vscode.Uri.file(path.join(homeDir || "", defaultName));

        const result = await vscode.window.showSaveDialog({
            defaultUri,
            title: "Select Workspace Location",
            filters: { "All Files": ["*"] },
        });

        if (result) {
            // Create the directory if it doesn't exist
            try {
                await vscode.workspace.fs.createDirectory(result);
                return result.fsPath;
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to create directory: ${
                        error instanceof Error ? error.message : "Unknown error"
                    }`
                );
                return undefined;
            }
        }
        return undefined;
    }

    private async cloneRepository(
        repoUrl: string,
        workspacePath: string // this is the path to the local directory where the repository will be cloned
    ): Promise<void> {
        try {
            const url = new URL(repoUrl);
            const gitlabToken = await this.gitLabService.getToken();
            if (!gitlabToken) {
                throw new Error("GitLab token not available");
            }

            // Set up authentication
            const auth = {
                username: "oauth2",
                password: gitlabToken,
            };

            // Clone the repository
            await this.gitService.clone(repoUrl, workspacePath, auth);

            // Ensure remote is properly configured
            const remotes = await this.gitService.getRemotes(workspacePath);
            if (!remotes.some((r) => r.remote === "origin")) {
                await this.gitService.addRemote(workspacePath, "origin", repoUrl);
            }

            // console.log("Repository cloned successfully to:", workspacePath);
        } catch (error) {
            console.error("Clone error:", error);
            throw new Error(
                `Failed to clone repository: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    }

    async initializeSCM(workspacePath: string): Promise<void> {
        try {
            // Check if git is initialized
            const hasGit = await this.gitService.hasGitRepository(workspacePath);
            if (!hasGit) {
                await this.gitService.init(workspacePath);
            }

            // Get current user info and configure git
            const user = await this.gitLabService.getCurrentUser();
            const authorName = user.name || user.username;
            const authorEmail = user.email || `${user.username}@users.noreply.gitlab.com`;
            await this.gitService.configureAuthor(workspacePath, authorName, authorEmail);

            // Set up file watcher
            this.setupFileWatcher(workspacePath);

            // Load .gitignore patterns
            await this.loadGitIgnore(workspacePath);

            // Initialize LFS tracking and fix .gitignore conflicts
            await this.setupLFSAndFixGitIgnore(workspacePath);

            // Check remote configuration
            const remotes = await this.gitService.getRemotes(workspacePath);
            const remoteUrl = await this.gitService.getRemoteUrl(workspacePath);

            if (remoteUrl && !remotes.some((r) => r.remote === "origin")) {
                await this.gitService.addRemote(workspacePath, "origin", remoteUrl);
            }

            console.log("SCM initialized successfully");
        } catch (error) {
            console.error("SCM initialization error:", error);
            throw new Error(
                `Failed to initialize SCM: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    }

    /**
     * Set up LFS tracking and fix .gitignore conflicts
     */
    private async setupLFSAndFixGitIgnore(workspacePath: string): Promise<void> {
        try {
            // Initialize LFS tracking
            await this.gitService.setupLFSTracking(workspacePath);

            // Fix .gitignore to work with LFS
            await this.fixGitIgnoreForLFS(workspacePath);

            console.log("LFS tracking set up and .gitignore fixed");
        } catch (error) {
            console.error("Error setting up LFS:", error);
            // Don't throw - LFS is not critical for basic operation
            vscode.window.showWarningMessage(
                "LFS setup failed. Large files may not be handled optimally."
            );
        }
    }

    /**
     * Fix .gitignore to ensure LFS-tracked files are not ignored
     */
    private async fixGitIgnoreForLFS(workspacePath: string): Promise<void> {
        const gitIgnorePath = path.join(workspacePath, ".gitignore");

        try {
            // Read current .gitignore
            let content = "";
            try {
                const gitIgnoreUri = vscode.Uri.file(gitIgnorePath);
                const fileContent = await vscode.workspace.fs.readFile(gitIgnoreUri);
                content = Buffer.from(fileContent).toString("utf8");
            } catch (error) {
                // File doesn't exist, create with our template
                content = "";
            }

            // Parse lines
            const lines = content.split("\n");
            const newLines: string[] = [];
            let inLFSSection = false;
            let hasLFSSection = false;

            // Patterns that should be removed from .gitignore (will be handled by LFS)
            const lfsPatterns = [
                "*.mp4",
                "*.avi",
                "*.mov",
                "*.wmv",
                "*.flv",
                "*.mkv",
                "*.webm",
                "*.m4v",
                "*.3gp",
                "*.mpg",
                "*.mpeg",
                "*.mp3",
                "*.wav",
                "*.flac",
                "*.m4a",
                "*.ogg",
                "*.aac",
                "*.jpg",
                "*.jpeg",
                "*.png",
                "*.gif",
                "*.bmp",
                "*.tiff",
                "*.tif",
                "*.svg",
                "*.webp",
                "*.ico",
                "*.psd",
                "*.ai",
                "*.eps",
                "*.raw",
                "*.cr2",
                "*.nef",
                "*.dng",
                "*.zip",
                "*.rar",
                "*.7z",
                "*.tar",
                "*.tar.gz",
                "*.tar.bz2",
                "*.tar.xz",
                "*.gz",
                "*.bz2",
                "*.xz",
                "*.pdf",
            ];

            // Process each line
            for (const line of lines) {
                const trimmedLine = line.trim();

                // Check if we're entering/leaving LFS section
                if (trimmedLine === "# LFS-managed files (do not add to .gitignore)") {
                    inLFSSection = true;
                    hasLFSSection = true;
                    newLines.push(line);
                    continue;
                } else if (
                    inLFSSection &&
                    trimmedLine.startsWith("#") &&
                    !trimmedLine.startsWith("# ")
                ) {
                    inLFSSection = false;
                }

                // Skip multimedia patterns that will be handled by LFS
                if (!inLFSSection && lfsPatterns.some((pattern) => trimmedLine === pattern)) {
                    continue;
                }

                // Special handling for .project/attachments/
                if (trimmedLine === ".project/attachments/") {
                    // Comment it out instead of removing
                    newLines.push("# .project/attachments/ # Commented out - handled by Git LFS");
                    continue;
                }

                newLines.push(line);
            }

            // Add LFS section if it doesn't exist
            if (!hasLFSSection) {
                newLines.push("");
                newLines.push("# LFS-managed files (do not add to .gitignore)");
                newLines.push("# Large files and multimedia are tracked via Git LFS");
                newLines.push("# See .gitattributes for LFS tracking patterns");
                newLines.push("");
                newLines.push("# The following patterns have been removed from .gitignore:");
                newLines.push("# - Multimedia files (*.mp4, *.jpg, etc.) - tracked by LFS");
                newLines.push("# - Archive files (*.zip, *.rar, etc.) - tracked by LFS");
                newLines.push("# - .project/attachments/ - tracked by LFS");
                newLines.push("");
            }

            // Write updated .gitignore
            const updatedContent = newLines.join("\n");
            const gitIgnoreUri = vscode.Uri.file(gitIgnorePath);
            await vscode.workspace.fs.writeFile(gitIgnoreUri, Buffer.from(updatedContent, "utf8"));

            // Also ensure .project/attachments/ directory exists and has a .gitkeep file
            const attachmentsPath = path.join(workspacePath, ".project", "attachments");
            const attachmentsUri = vscode.Uri.file(attachmentsPath);

            try {
                await vscode.workspace.fs.createDirectory(attachmentsUri);

                // Add .gitkeep to ensure directory is tracked
                const gitkeepPath = path.join(attachmentsPath, ".gitkeep");
                const gitkeepUri = vscode.Uri.file(gitkeepPath);
                await vscode.workspace.fs.writeFile(gitkeepUri, Buffer.from("", "utf8"));
            } catch (error) {
                // Directory might already exist, that's fine
            }

            console.log("Fixed .gitignore for LFS compatibility");
        } catch (error) {
            console.error("Error fixing .gitignore:", error);
            throw new Error(
                `Failed to fix .gitignore: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    private async openWorkspace(workspacePath: string): Promise<void> {
        const uri = vscode.Uri.file(workspacePath);
        await vscode.commands.executeCommand("vscode.openFolder", uri);
    }

    private async loadGitIgnore(workspacePath: string): Promise<void> {
        try {
            const gitIgnoreUri = vscode.Uri.file(path.join(workspacePath, ".gitignore"));
            try {
                const content = await vscode.workspace.fs.readFile(gitIgnoreUri);
                this.gitIgnorePatterns = Buffer.from(content)
                    .toString("utf8")
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line && !line.startsWith("#"));
            } catch (error) {
                // It's okay if .gitignore doesn't exist
                this.gitIgnorePatterns = [];
            }
        } catch (error) {
            console.error("Error loading .gitignore:", error);
            this.gitIgnorePatterns = [];
        }
    }

    private shouldIgnoreFile(filePath: string): boolean {
        const relativePath = vscode.workspace.asRelativePath(filePath);
        return this.gitIgnorePatterns.some((pattern) => {
            if (pattern.endsWith("/")) {
                return relativePath.startsWith(pattern);
            }
            return new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(relativePath);
        });
    }

    private setupFileWatcher(workspacePath: string): void {
        // Dispose existing watcher if any
        this.fileSystemWatcher?.dispose();

        // Create new watcher for all files in workspace
        this.fileSystemWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspacePath, "**/*")
        );

        // Handle file changes
        this.fileSystemWatcher.onDidChange(async (uri) => {
            if (this.autoSyncEnabled && !this.shouldIgnoreFile(uri.fsPath)) {
                await this.syncChanges();
            }
        });

        this.fileSystemWatcher.onDidCreate(async (uri) => {
            // Check if this is a multimedia file that should be LFS tracked
            await this.checkNewFileForLFS(uri.fsPath);

            if (this.autoSyncEnabled && !this.shouldIgnoreFile(uri.fsPath)) {
                await this.syncChanges();
            }
        });

        this.fileSystemWatcher.onDidDelete(async (uri) => {
            if (this.autoSyncEnabled && !this.shouldIgnoreFile(uri.fsPath)) {
                await this.syncChanges();
            }
        });
    }

    /**
     * Check if a newly created file should be LFS tracked but is being ignored
     */
    private async checkNewFileForLFS(filePath: string): Promise<void> {
        try {
            // Check if notifications are enabled
            const notifyEnabled = vscode.workspace
                .getConfiguration("frontier")
                .get("notifyLFSConflicts", true);
            if (!notifyEnabled) {
                return;
            }

            const workspacePath = this.getWorkspacePath();

            // Check if this file should be LFS tracked
            const stats = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
            const relativePath = vscode.workspace.asRelativePath(filePath);

            const shouldBeLFS = this.gitService.shouldFileUseEFS(relativePath, stats.size);
            const isBeingIgnored = this.shouldIgnoreFile(filePath);

            if (shouldBeLFS && isBeingIgnored) {
                console.log(`Detected LFS file being ignored: ${relativePath}`);

                // Show notification with action
                const action = await vscode.window.showWarningMessage(
                    `File "${relativePath}" should be tracked by Git LFS but is being ignored by .gitignore`,
                    "Fix LFS Setup",
                    "Ignore"
                );

                if (action === "Fix LFS Setup") {
                    await this.setupLFSAndFixGitIgnore(workspacePath);

                    // Commit changes if auto-commit is enabled
                    const autoCommitEnabled = vscode.workspace
                        .getConfiguration("frontier")
                        .get("autoCommitLFSFixes", true);
                    if (autoCommitEnabled) {
                        await this.commitLFSFixChanges(workspacePath);
                    }

                    vscode.window.showInformationMessage(
                        "LFS setup fixed! Multimedia files will now be tracked properly."
                    );
                }
            }
        } catch (error) {
            console.error("Error checking new file for LFS:", error);
            // Don't show error to user for automatic checks
        }
    }

    async syncChanges(): Promise<{ hasConflicts: boolean; conflicts?: ConflictedFile[] }> {
        // Create or show the status bar item
        if (!this.syncStatusBarItem) {
            this.syncStatusBarItem = vscode.window.createStatusBarItem(
                vscode.StatusBarAlignment.Right,
                100
            );
        }

        // Start animation
        let animationFrame = 0;
        const animationFrames = ["$(cloud-upload)", "$(cloud)", "$(cloud-download)"];
        const animationInterval = setInterval(() => {
            if (this.syncStatusBarItem) {
                this.syncStatusBarItem.text = `${animationFrames[animationFrame]} Syncing...`;
                this.syncStatusBarItem.show();
                animationFrame = (animationFrame + 1) % animationFrames.length;
            }
        }, 500);

        try {
            const token = await this.gitLabService.getToken();
            if (!token) {
                throw new Error("GitLab token not found. Please authenticate first.");
            }

            const auth = {
                username: "oauth2",
                password: token,
            };

            const workspacePath = this.getWorkspacePath();

            // Check and fix LFS setup before syncing (but not every time)
            const autoFixEnabled = vscode.workspace
                .getConfiguration("frontier")
                .get("autoFixLFS", true);
            if (autoFixEnabled) {
                const shouldCheckLFS = await this.shouldCheckLFSDuringSync();
                if (shouldCheckLFS) {
                    const needsLFSFix = await this.checkIfLFSFixNeeded(workspacePath);
                    if (needsLFSFix) {
                        console.log("Fixing LFS setup during sync...");
                        await this.setupLFSAndFixGitIgnore(workspacePath);

                        // Commit changes if auto-commit is enabled
                        const autoCommitEnabled = vscode.workspace
                            .getConfiguration("frontier")
                            .get("autoCommitLFSFixes", true);
                        if (autoCommitEnabled) {
                            await this.commitLFSFixChanges(workspacePath);
                        }
                    }
                }
            }

            const user = await this.gitLabService.getCurrentUser();
            if (!user) {
                throw new Error("Could not get user information from GitLab");
            }

            const author = {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            };

            // Try to sync and get result
            const syncResult = await this.gitService.syncChanges(workspacePath, auth, author);

            // If we have conflicts, return them to client
            if (syncResult.hadConflicts && syncResult.conflicts) {
                return {
                    hasConflicts: true,
                    conflicts: syncResult.conflicts,
                };
            }

            // Everything synced successfully
            return { hasConflicts: false };
        } catch (error) {
            console.error("Sync error:", error);
            throw error;
        } finally {
            // Stop animation and update status
            clearInterval(animationInterval);
            if (this.syncStatusBarItem) {
                this.syncStatusBarItem.text = `$(cloud) Synced`;
                // Hide after a short delay
                setTimeout(() => {
                    if (this.syncStatusBarItem) {
                        this.syncStatusBarItem.hide();
                    }
                }, 3000);
            }
        }
    }

    /**
     * Determine if we should check LFS during sync (throttled to avoid checking every time)
     */
    private async shouldCheckLFSDuringSync(): Promise<boolean> {
        const LAST_LFS_CHECK_KEY = "lastLFSCheck";
        const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

        try {
            const lastCheck = this.context.globalState.get<number>(LAST_LFS_CHECK_KEY, 0);
            const now = Date.now();

            if (now - lastCheck > CHECK_INTERVAL) {
                await this.context.globalState.update(LAST_LFS_CHECK_KEY, now);
                return true;
            }

            return false;
        } catch (error) {
            console.error("Error checking LFS sync throttle:", error);
            return false;
        }
    }

    enableAutoSync(workspacePath: string, intervalMinutes: number = 5): void {
        this.autoSyncEnabled = true;
        this.autoSyncInterval = setInterval(
            () => {
                this.syncChanges().catch((error) => {
                    console.error("Auto-sync error:", error);
                    vscode.window.showErrorMessage(
                        `Auto-sync failed: ${
                            error instanceof Error ? error.message : "Unknown error"
                        }`
                    );
                });
            },
            intervalMinutes * 60 * 1000
        );
    }

    disableAutoSync(): void {
        this.autoSyncEnabled = false;
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = undefined;
        }
    }

    isAutoSyncEnabled(): boolean {
        return this.autoSyncEnabled;
    }

    private async commitChanges(): Promise<void> {
        try {
            const message = this.scmProvider.inputBox.value;
            if (!message) {
                throw new Error("Please enter a commit message");
            }

            const workspacePath = this.getWorkspacePath();

            // Get current user info for commit author details
            const user = await this.gitLabService.getCurrentUser();

            // Add all changes
            await this.gitService.addAll(workspacePath);

            // Commit
            await this.gitService.commit(workspacePath, message, {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            });

            // Clear the input box
            this.scmProvider.inputBox.value = "";

            // Push changes
            const token = await this.gitLabService.getToken();
            if (!token) {
                throw new Error("GitLab token not found. Please authenticate first.");
            }

            const auth = {
                username: "oauth2",
                password: token,
            };

            await this.gitService.push(workspacePath, auth);

            vscode.window.showInformationMessage("Changes committed and pushed successfully");
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to commit changes: ${error.message}`);
            }
        }
    }

    private async toggleAutoSync(): Promise<void> {
        this.autoSyncEnabled = !this.autoSyncEnabled;
        vscode.window.showInformationMessage(
            `Auto-sync is now ${this.autoSyncEnabled ? "enabled" : "disabled"}`
        );
    }

    /**
     * Public method to fix LFS setup for existing projects
     */
    public async fixLFSForExistingProject(): Promise<void> {
        try {
            const workspacePath = this.getWorkspacePath();

            vscode.window.showInformationMessage("Fixing LFS setup for current project...");

            // Set up LFS and fix .gitignore
            await this.setupLFSAndFixGitIgnore(workspacePath);

            // Commit the changes
            const token = await this.gitLabService.getToken();
            if (!token) {
                throw new Error("GitLab token not found. Please authenticate first.");
            }

            const auth = {
                username: "oauth2",
                password: token,
            };

            const user = await this.gitLabService.getCurrentUser();
            if (!user) {
                throw new Error("Could not get user information from GitLab");
            }

            const author = {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            };

            // Check if there are changes to commit
            const status = await this.gitService.getStatus(workspacePath);
            const hasChanges = status.some(
                ([_, head, workdir, stage]) => head !== workdir || head !== stage
            );

            if (hasChanges) {
                await this.gitService.addAll(workspacePath);
                await this.gitService.commit(
                    workspacePath,
                    "Enable Git LFS for multimedia files and attachments",
                    author
                );

                // Sync changes
                await this.syncChanges();

                vscode.window.showInformationMessage(
                    "LFS setup complete! Multimedia files and attachments will now be tracked via Git LFS."
                );
            } else {
                vscode.window.showInformationMessage("LFS is already set up correctly.");
            }
        } catch (error) {
            console.error("Error fixing LFS setup:", error);
            vscode.window.showErrorMessage(
                `Failed to fix LFS setup: ${error instanceof Error ? error.message : "Unknown error"}`
            );
            throw error;
        }
    }

    async publishWorkspace(options: {
        name: string;
        description?: string;
        visibility?: "private" | "internal" | "public";
        groupId?: string;
        force: boolean;
    }): Promise<void> {
        try {
            console.log("Starting workspace publish with options:", options);

            // Initialize GitLab service
            await this.gitLabService.initializeWithRetry();

            // Get workspace path
            const workspacePath = this.getWorkspacePath();
            console.log("Using workspace path:", workspacePath);

            // Create the project
            console.log("Creating GitLab project...");
            const project = await this.gitLabService.createProject({
                name: options.name,
                description: options.description,
                visibility: options.visibility,
                groupId: options.groupId,
            });
            console.log("Project created successfully:", project);

            // Initialize git repository if not already initialized
            const isGitRepo = await this.gitService.hasGitRepository(workspacePath);
            if (!isGitRepo) {
                console.log("Initializing git repository...");
                await this.gitService.init(workspacePath);
            }

            // Set up LFS and fix .gitignore BEFORE adding files
            console.log("Setting up LFS and fixing .gitignore...");
            await this.setupLFSAndFixGitIgnore(workspacePath);

            // Add remote if not already added
            const currentRemoteUrl = await this.gitService.getRemoteUrl(workspacePath);
            if (!currentRemoteUrl) {
                console.log("Adding git remote...");
                await this.gitService.addRemote(workspacePath, "origin", project.url);
            }

            // Add all files
            console.log("Adding files to git...");
            await this.gitService.addAll(workspacePath);

            // Create initial commit
            console.log("Creating initial commit...");
            const user = await this.gitLabService.getCurrentUser();
            await this.gitService.commit(workspacePath, "Initial commit", {
                name: user.name || user.username,
                email: user.email || `${user.username}@users.noreply.gitlab.com`,
            });

            // Push to remote
            console.log("Pushing to remote...");
            const gitlabToken = await this.gitLabService.getToken();
            if (!gitlabToken) {
                throw new Error("GitLab token not available");
            }
            await this.gitService.push(
                workspacePath,
                {
                    username: "oauth2",
                    password: gitlabToken,
                },
                { force: options.force }
            );

            // Initialize SCM
            console.log("Initializing SCM...");
            await this.initializeSCM(workspacePath);

            vscode.window.showInformationMessage(
                `Workspace published successfully to ${project.url}`
            );
        } catch (error) {
            console.error("Error in publishWorkspace:", error);
            if (error instanceof Error) {
                const errorMessage = error.message;
                vscode.window.showErrorMessage(`Failed to publish workspace: ${errorMessage}`);
                throw new Error(`Failed to publish workspace: ${errorMessage}`);
            }
            throw error;
        }
    }

    // Add new method to complete merge
    async completeMerge(resolvedFiles: ResolvedFile[]): Promise<void> {
        const token = await this.gitLabService.getToken();
        if (!token) {
            throw new Error("GitLab token not found");
        }

        const auth = {
            username: "oauth2",
            password: token,
        };

        const user = await this.gitLabService.getCurrentUser();
        if (!user) {
            throw new Error("Could not get user information");
        }

        const author = {
            name: user.name || user.username,
            email: user.email || `${user.username}@users.noreply.gitlab.com`,
        };

        const workspacePath = this.getWorkspacePath();
        await this.gitService.completeMerge(workspacePath, auth, author, resolvedFiles);
    }
}
