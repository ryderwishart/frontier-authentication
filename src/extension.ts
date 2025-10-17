// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { FrontierAuthProvider } from "./auth/AuthenticationProvider";
import { registerCommands } from "./commands";
import { registerGitLabCommands } from "./commands/gitlabCommands";
import { registerProgressCommands } from "./commands/progressCommands";
import { registerSCMCommands } from "./commands/scmCommands";
import {
    registerVersionCheckCommands,
    resetVersionModalCooldown,
} from "./utils/extensionVersionChecker";
import { initialState, StateManager } from "./state";
import { AuthState } from "./types/state";
import { ConflictedFile } from "./git/GitService";

export interface BookCompletionData {
    completionPercentage: number;
    sourceWords: number;
    targetWords: number;
}

export interface ProjectProgressReport {
    projectId: string; // Unique project identifier
    timestamp: string; // ISO timestamp of report generation
    reportId: string; // Unique report identifier

    // Translation metrics
    translationProgress: {
        bookCompletionMap: Record<string, BookCompletionData>; // Book ID -> completion data with word counts
        totalVerseCount: number; // Total verses in project
        translatedVerseCount: number; // Verses with translations
        validatedVerseCount: number; // Verses passing validation
        wordsTranslated: number; // Total words translated
    };

    // Validation metrics
    validationStatus: {
        stage: "none" | "initial" | "community" | "expert" | "finished";
        versesPerStage: Record<string, number>; // Stage -> verse count
        lastValidationTimestamp: string; // ISO timestamp
    };

    // Activity metrics
    activityMetrics: {
        lastEditTimestamp: string; // ISO timestamp
        editCountLast24Hours: number; // Edit count
        editCountLastWeek: number; // Edit count
        averageDailyEdits: number; // Avg edits per active day
    };

    // Quality indicators
    qualityMetrics: {
        spellcheckIssueCount: number; // Spelling issues
        flaggedSegmentsCount: number; // Segments needing review
        consistencyScore: number; // 0-100 score
    };
}

export type MediaFilesStrategy =
    | "auto-download" // Download and save media files automatically
    | "stream-and-save" // Stream media files and save in background
    | "stream-only"; // Stream media files without saving (read from network each time)

export interface FrontierAPI {
    authProvider: FrontierAuthProvider;
    getAuthStatus: () => {
        isAuthenticated: boolean;
    };
    onAuthStatusChanged: (
        callback: (status: { isAuthenticated: boolean }) => void
    ) => vscode.Disposable;
    login: (username: string, password: string) => Promise<boolean>;
    register: (username: string, email: string, password: string) => Promise<boolean>;
    logout: () => Promise<void>;
    listProjects: (showUI?: boolean) => Promise<
        Array<{
            id: number;
            name: string;
            description: string | null;
            visibility: string;
            url: string;
            webUrl: string;
            lastActivity: string;
            namespace: string;
            owner: string;
        }>
    >;
    cloneRepository: (
        repositoryUrl: string,
        cloneToPath?: string,
        openWorkspace?: boolean,
        mediaStrategy?: MediaFilesStrategy
    ) => Promise<boolean>;
    /** Store per-repo media strategy preference */
    setRepoMediaStrategy: (workspacePath: string, strategy: MediaFilesStrategy) => Promise<void>;
    publishWorkspace: (options: {
        name?: string;
        description?: string;
        visibility?: "private" | "internal" | "public";
        groupId?: string;
        force: boolean;
    }) => Promise<void>;
    getUserInfo: () => Promise<{
        email: string;
        username: string;
    }>;
    getLlmEndpoint: () => Promise<string | undefined>;
    getAsrEndpoint: () => Promise<string | undefined>;
    syncChanges: (options?: { commitMessage?: string }) => Promise<{
        hasConflicts: boolean;
        conflicts?: Array<ConflictedFile>;
        offline?: boolean;
    }>;
    completeMerge: (
        resolvedFiles: ResolvedFile[],
        workspacePath: string | undefined
    ) => Promise<void>;

    // Project Progress Reporting API
    submitProgressReport: (
        report: ProjectProgressReport
    ) => Promise<{ success: boolean; reportId: string }>;

    getProgressReports: (options: {
        projectIds?: string[]; // Filter by specific projects
        startDate?: string; // Filter by date range
        endDate?: string;
        limit?: number; // Pagination
        offset?: number;
    }) => Promise<{
        reports: ProjectProgressReport[];
        totalCount: number;
    }>;

    getAggregatedProgress: () => Promise<{
        projectCount: number;
        activeProjectCount: number;
        totalCompletionPercentage: number;
        projectSummaries: Array<{
            projectId: string;
            projectName: string;
            completionPercentage: number;
            lastActivity: string;
            stage: string;
        }>;
    }>;

    /**
     * Download a single LFS file by OID
     * @param projectPath - Path to the git repository
     * @param oid - SHA256 OID of the LFS object
     * @param size - Expected size of the object in bytes
     * @returns Buffer containing the file data
     * @throws Error if not authenticated, no remote URL, or download fails
     */
    downloadLFSFile: (projectPath: string, oid: string, size: number) => Promise<Buffer>;
}

export interface ResolvedFile {
    filepath: string;
    resolution: "deleted" | "created" | "modified";
}

let authenticationProvider: FrontierAuthProvider;

const API_ENDPOINT = "https://api.frontierrnd.com/api/v1";
// const API_ENDPOINT = "http://localhost:8000/api/v1"; // Use this for local development when the frontier server is running locally

// FIXME: let's gracefully handle offline (block login, for instance)
// TODO: let's display status for the user - cloud sync available, AI online, etc.
// TODO: if the user wants to use an offline LLM, we should check the heartbeat, etc.

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    // Initialize state manager first
    const stateManager = StateManager.initialize(context);

    // Initialize auth provider with state manager
    authenticationProvider = new FrontierAuthProvider(context, API_ENDPOINT, stateManager);

    try {
        await authenticationProvider.initialize();
    } catch (error) {
        console.error("Error initializing authentication provider:", error);
        // Continue anyway, as initialization errors will be handled gracefully
        // and retried with exponential backoff as needed
    }

    // Create GitService for debug logging control
    const stateManagerInstance = StateManager.getInstance();
    const { GitService } = await import("./git/GitService");
    const gitService = new GitService(stateManagerInstance);

    // Register commands - pass gitService for debug toggle
    registerCommands(context, authenticationProvider, gitService);
    registerGitLabCommands(context, authenticationProvider);
    registerSCMCommands(context, authenticationProvider);
    registerProgressCommands(context, authenticationProvider);
    registerVersionCheckCommands(context);

    // Store API endpoint for use by other components
    context.globalState.update("frontierApiEndpoint", API_ENDPOINT);

    // Reset version modal cooldown on extension activation
    await resetVersionModalCooldown(context);

    // Create and register status bar item immediately
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);

    // Create progress status bar item
    const progressStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        99
    );
    progressStatusBarItem.text = "$(sync) Translation Progress";
    progressStatusBarItem.tooltip = "View translation progress";
    progressStatusBarItem.command = "frontier.showProgressDashboard";
    context.subscriptions.push(progressStatusBarItem);

    // Update status bar when state changes
    stateManager.onDidChangeState(() => {
        updateStatusBar(statusBarItem, stateManager.getAuthState());
        updateProgressStatusBar(progressStatusBarItem, stateManager.getAuthState());
    });

    // Initial status bar update and show
    updateStatusBar(statusBarItem, stateManager.getAuthState());
    updateProgressStatusBar(progressStatusBarItem, stateManager.getAuthState());
    statusBarItem.show();

    // Only show activation message if not already authenticated
    if (!authenticationProvider.isAuthenticated) {
        vscode.window.showInformationMessage(
            "Frontier Authentication: Click the status bar icon to log in"
        );
    } else {
        // For existing authenticated users, try to cache user info if not already cached
        setTimeout(() => {
            authenticationProvider.fetchAndCacheUserInfo().catch((error) => {
                console.error("Error caching user info during activation:", error);
            });
        }, 1000); // Small delay to ensure initialization is complete
    }

    // Do not dispose the freshly created authentication provider here.
    // Disposing would unregister its event emitters and prevent VS Code's
    // Accounts UI from receiving session change events (e.g., on logout).

    // Register status bar item
    // Removed redundant registration here

    const frontierAPI: FrontierAPI = {
        // Export the authentication provider for other extensions
        authProvider: authenticationProvider,

        // Export convenience methods
        getAuthStatus: () => authenticationProvider.getAuthStatus(),
        onAuthStatusChanged: (callback: (status: { isAuthenticated: boolean }) => void) =>
            authenticationProvider.onAuthStatusChanged(callback),

        // Export direct auth methods
        login: async (username: string, password: string) =>
            vscode.commands.executeCommand(
                "frontier.login",
                username,
                password
            ) as Promise<boolean>,
        register: async (username: string, email: string, password: string) =>
            vscode.commands.executeCommand(
                "frontier.register",
                username,
                email,
                password
            ) as Promise<boolean>,
        logout: async () => vscode.commands.executeCommand("frontier.logout"),
        listProjects: async (showUI = true) =>
            vscode.commands.executeCommand("frontier.listProjects", {
                showUI,
            }) as Promise<
                Array<{
                    id: number;
                    name: string;
                    description: string | null;
                    visibility: string;
                    url: string;
                    webUrl: string;
                    lastActivity: string;
                    namespace: string;
                    owner: string;
                }>
            >,
        cloneRepository: async (
            repositoryUrl: string,
            cloneToPath?: string,
            openWorkspace?: boolean,
            mediaStrategy?: MediaFilesStrategy
        ) =>
            vscode.commands.executeCommand<boolean>(
                "frontier.cloneRepository",
                repositoryUrl,
                cloneToPath,
                openWorkspace,
                mediaStrategy
            ),
        publishWorkspace: async (options: {
            name?: string;
            description?: string;
            visibility?: "private" | "internal" | "public";
            groupId?: string;
            force: boolean;
        }) => {
            try {
                await vscode.commands.executeCommand("frontier.publishWorkspace", {
                    ...options,
                    force: true, // Always force push when publishing, since it won't be a simple fast-forward
                });
            } catch (error: unknown) {
                if (
                    error instanceof Error &&
                    error.message.includes("Push rejected because it was not a simple fast-forward")
                ) {
                    throw new Error(
                        "Failed to publish workspace: Push rejected. Use 'force: true' to override."
                    );
                } else {
                    throw error;
                }
            }
        },
        getUserInfo: async () => {
            const { isAuthenticated } = authenticationProvider.getAuthStatus();
            if (isAuthenticated) {
                return vscode.commands.executeCommand("frontier.getUserInfo") as Promise<{
                    email: string;
                    username: string;
                }>;
            } else {
                return {
                    email: "",
                    username: "",
                };
            }
        },
        getLlmEndpoint: async () => {
            return API_ENDPOINT;
        },
        getAsrEndpoint: async () => {
            if (!authenticationProvider.isAuthenticated) {
                return undefined;
            }
            // Transform HTTPS endpoint to WSS for WebSocket
            const wsUrl = API_ENDPOINT.replace("https://", "wss://").replace("http://", "ws://");
            return `${wsUrl}/ws/asr?source=codex`;
        },
        syncChanges: async (options?: { commitMessage?: string }) =>
            vscode.commands.executeCommand("frontier.syncChanges", options) as Promise<{
                hasConflicts: boolean;
                conflicts?: Array<ConflictedFile>;
                offline?: boolean;
            }>,
        completeMerge: async (resolvedFiles: ResolvedFile[], workspacePath: string | undefined) =>
            vscode.commands.executeCommand(
                "frontier.completeMerge",
                resolvedFiles,
                workspacePath
            ) as Promise<void>,

        // Project Progress Reporting API
        submitProgressReport: async (report: ProjectProgressReport) =>
            vscode.commands.executeCommand("frontier.submitProgressReport", report) as Promise<{
                success: boolean;
                reportId: string;
            }>,

        getProgressReports: async (options: {
            projectIds?: string[];
            startDate?: string;
            endDate?: string;
            limit?: number;
            offset?: number;
        }) =>
            vscode.commands.executeCommand("frontier.getProgressReports", options) as Promise<{
                reports: ProjectProgressReport[];
                totalCount: number;
            }>,

        getAggregatedProgress: async () =>
            vscode.commands.executeCommand("frontier.getAggregatedProgress") as Promise<{
                projectCount: number;
                activeProjectCount: number;
                totalCompletionPercentage: number;
                projectSummaries: Array<{
                    projectId: string;
                    projectName: string;
                    completionPercentage: number;
                    lastActivity: string;
                    stage: string;
                }>;
            }>,

        downloadLFSFile: async (
            projectPath: string,
            oid: string,
            size: number
        ): Promise<Buffer> => {
            // Import GitService and downloadLFSObject
            const { GitService } = await import("./git/GitService");
            const gitService = new GitService(stateManager);

            // Validate inputs
            if (!projectPath) {
                throw new Error("Project path is required");
            }
            if (!oid || !/^[a-f0-9]{64}$/i.test(oid)) {
                throw new Error("Invalid OID format (expected 64-character hex string)");
            }
            if (!size || size <= 0) {
                throw new Error("Invalid size (must be positive number)");
            }

            // Get remote URL
            const remoteUrl = await gitService.getRemoteUrl(projectPath);
            if (!remoteUrl) {
                throw new Error(
                    "No remote URL found for project. This project may not be connected to a remote repository."
                );
            }

            // Parse URL and prepare auth
            const { GitService: GitServiceStatic } = await import("./git/GitService");
            const { cleanUrl, auth: embedded } = GitServiceStatic.parseGitUrl(remoteUrl);
            const lfsBaseUrl = cleanUrl.endsWith(".git") ? cleanUrl : `${cleanUrl}.git`;

            // Prefer embedded auth in remote URL if present; otherwise, fetch token from GitLabService
            let auth: { username?: string; password?: string; token?: string } | undefined =
                embedded;
            if (!auth || !auth.password) {
                try {
                    const { GitLabService } = await import("./gitlab/GitLabService");
                    const gl = new GitLabService(authenticationProvider);
                    // Ensure service is initialized (handles retries)
                    await gl.initializeWithRetry?.();
                    const token = await gl.getToken();
                    if (!token) {
                        throw new Error(
                            "Not authenticated. Please log in to download media files."
                        );
                    }
                    auth = { username: "oauth2", password: token };
                } catch (e) {
                    throw new Error("Not authenticated. Please log in to download media files.");
                }
            }

            // Download LFS object using the internal function
            // We need to import and call downloadLFSObject directly
            const { downloadLFSObject } = await import("./git/GitService");

            try {
                const bytes = await downloadLFSObject(
                    {
                        url: lfsBaseUrl,
                        headers: {},
                        auth,
                    },
                    { oid, size }
                );

                return Buffer.from(bytes);
            } catch (error) {
                // Provide more context in error message
                const errorMsg = error instanceof Error ? error.message : String(error);

                if (errorMsg.includes("404") || errorMsg.includes("not found")) {
                    throw new Error(
                        `Media file not found on server (OID: ${oid.substring(0, 8)}...)`
                    );
                } else if (errorMsg.includes("401") || errorMsg.includes("403")) {
                    throw new Error("Authentication failed. Please log in again.");
                } else if (errorMsg.includes("timeout") || errorMsg.includes("ETIMEDOUT")) {
                    throw new Error("Download timed out. Please check your internet connection.");
                } else {
                    throw new Error(`Failed to download media file: ${errorMsg}`);
                }
            }
        },
        setRepoMediaStrategy: async (
            workspacePath: string,
            strategy: MediaFilesStrategy
        ): Promise<void> => {
            try {
                await stateManager.setRepoStrategy(workspacePath, strategy);
            } catch (e) {
                console.warn("Failed to set repo media strategy:", e);
                throw e;
            }
        },
    };

    return frontierAPI;
}

function updateStatusBar(statusBarItem: vscode.StatusBarItem, authState: AuthState) {
    if (authState.isAuthenticated) {
        statusBarItem.text = "$(check) Frontier: Logged In";
        statusBarItem.tooltip = "Click to log out";
        statusBarItem.command = "frontier.logout";
    } else {
        statusBarItem.text = "$(sign-in) Frontier: Sign In";
        statusBarItem.tooltip = "Click to log in";
        statusBarItem.command = "frontier.login";
    }
    statusBarItem.show(); // Always show the status bar item
}

function updateProgressStatusBar(statusBarItem: vscode.StatusBarItem, authState: AuthState) {
    if (authState.isAuthenticated) {
        statusBarItem.show();
    } else {
        statusBarItem.hide();
    }
}

// This method is called when your extension is deactivated
export function deactivate() {
    if (authenticationProvider !== undefined) {
        authenticationProvider.dispose();
    }
}

// Expose the current auth provider instance for internal utilities/commands
export function getAuthProviderInstance(): FrontierAuthProvider | undefined {
    return authenticationProvider;
}
