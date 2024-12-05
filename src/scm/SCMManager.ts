import * as vscode from "vscode";
import * as path from "path";
import { GitService } from "../git/GitService";
import { GitLabService } from "../gitlab/GitLabService";

export class SCMManager {
    private scmProvider: vscode.SourceControl;
    private workingTree: vscode.SourceControlResourceGroup;
    private staging: vscode.SourceControlResourceGroup;
    private fileSystemWatcher: vscode.FileSystemWatcher | undefined;
    private gitService: GitService;
    private gitLabService: GitLabService;
    private autoSyncEnabled: boolean = false;
    private autoSyncInterval: NodeJS.Timeout | undefined;
    private gitIgnorePatterns: string[] = [];
    private readonly context: vscode.ExtensionContext;

    constructor(gitLabService: GitLabService, context: vscode.ExtensionContext) {
        this.context = context;
        this.gitService = new GitService();
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
    }

    private getWorkspacePath(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error("No workspace folder found");
        }
        const path = workspaceFolder.uri.fsPath;
        console.log("Using workspace path:", path);
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
    }

    async createAndCloneProject(options: {
        name: string;
        description?: string;
        visibility?: "private" | "internal" | "public";
        organizationId?: string;
        workspacePath?: string;
    }): Promise<void> {
        try {
            // Ensure GitLab service is initialized
            await this.gitLabService.initialize();

            // Check if project exists or create a new one
            const project = await this.gitLabService.createProject({
                name: options.name,
                description: options.description,
                visibility: options.visibility,
                organizationId: options.organizationId,
            });

            // Determine workspace path
            const workspacePath =
                options.workspacePath || (await this.promptForWorkspacePath(options.name));
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

    async cloneExistingRepository(repoUrl: string): Promise<void> {
        try {
            // Ensure GitLab service is initialized
            await this.gitLabService.initialize();

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
            const workspacePath = await this.promptForWorkspacePath(projectName);
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

    private async cloneRepository(repoUrl: string, workspacePath: string): Promise<void> {
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

            console.log("Repository cloned successfully to:", workspacePath);
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

    async syncChanges(): Promise<void> {
        const token = await this.gitLabService.getToken();
        if (!token) {
            throw new Error("GitLab token not found. Please authenticate first.");
        }

        const auth = {
            username: "oauth2",
            password: token,
        };

        try {
            const workspacePath = this.getWorkspacePath();
            console.log("Syncing changes in workspace:", workspacePath);

            // Verify that this is a git repository
            try {
                await this.gitService.getStatus(workspacePath);
            } catch (error) {
                console.error("Git status check failed:", error);
                throw new Error(
                    "Current workspace is not a git repository. Please initialize git or clone a repository first."
                );
            }

            // Get current user info for commit author details
            const user = await this.gitLabService.getCurrentUser();
            const authorName = user.name || user.username;
            const authorEmail = user.email || `${user.username}@users.noreply.gitlab.com`;

            // Ensure git config is set
            await this.gitService.configureAuthor(workspacePath, authorName, authorEmail);

            // Add all changes
            await this.gitService.addAll(workspacePath);

            // Get status to check if there are changes to commit
            const status = await this.gitService.getStatus(workspacePath);
            const hasChanges = status.some(([, , worktreeStatus]) => worktreeStatus !== 0);

            if (hasChanges) {
                console.log("Changes detected, committing...");
                // Commit changes
                await this.gitService.commit(workspacePath, "Auto-sync changes", {
                    name: authorName,
                    email: authorEmail,
                });

                // Pull any remote changes first
                console.log("Pulling remote changes...");
                await this.gitService.pull(workspacePath, auth, {
                    name: authorName,
                    email: authorEmail,
                });

                // Push changes
                console.log("Pushing changes...");
                await this.gitService.push(workspacePath, auth);
                console.log("Sync completed successfully");
            } else {
                console.log("No changes to sync");
            }
        } catch (error) {
            console.error("Sync error:", error);
            throw new Error(
                `Failed to sync changes: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
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

    async publishWorkspace(options: {
        name: string;
        description?: string;
        visibility?: "private" | "internal" | "public";
        organizationId?: string;
        force: boolean;
    }): Promise<void> {
        try {
            const workspacePath = this.getWorkspacePath();

            // Check if workspace is already a git repository
            const isGitRepo = await this.gitService.hasGitRepository(workspacePath);
            if (!isGitRepo) {
                await this.gitService.init(workspacePath);
                // Add all files
                await this.gitService.addAll(workspacePath);
                // We will make initial commit below
            }

            // NOTE: We are assuming that when codex-editor creates a new project,
            // we init a git repo using isomorphic git init. BUT we do not add a 
            // remote by default. Thus, when we use this publish function, we need
            // to create the remote project before pushing.

            // Get current remote URL if it exists
            const currentRemoteUrl = await this.gitService.getRemoteUrl(workspacePath);
            if (!currentRemoteUrl) {
                // Create a new project on GitLab
                const project = await this.gitLabService.createProject({
                    name: options.name,
                    description: options.description,
                    visibility: options.visibility,
                    organizationId: options.organizationId,
                });

                // Get GitLab credentials
                const gitlabToken = await this.gitLabService.getToken();
                if (!gitlabToken) {
                    throw new Error("GitLab token not available");
                }

                // Add remote
                await this.gitService.addRemote(workspacePath, "origin", project.url);

                // Get user info for commit author details
                const user = await this.gitLabService.getCurrentUser();
                const authorName = user.name || user.username;
                const authorEmail = user.email;
                if (!authorEmail) {
                    throw new Error("GitLab user email not available");
                }

                // Configure git author
                await this.gitService.configureAuthor(workspacePath, authorName, authorEmail);

                // If we just initialized the repo, create initial commit
                if (!isGitRepo) {
                    await this.gitService.commit(workspacePath, "Initial commit", {
                        name: authorName,
                        email: authorEmail,
                    });
                }

                // Push to remote with force option
                await this.gitService.push(workspacePath, {
                    username: "oauth2",
                    password: gitlabToken,
                }, options.force);

                vscode.window.showInformationMessage(
                    `Workspace published successfully to ${project.url}!`
                );
            } else {
                vscode.window.showInformationMessage(
                    "Workspace is already connected to a remote repository."
                );
            }

            // Initialize SCM provider
            await this.initializeSCM(workspacePath);
        } catch (error) {
            console.error("Publish workspace error:", error);
            throw new Error(
                `Failed to publish workspace: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`
            );
        }
    }
}
