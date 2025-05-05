// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { FrontierAuthProvider } from "./auth/AuthenticationProvider";
import { registerCommands } from "./commands";
import { registerGitLabCommands } from "./commands/gitlabCommands";
import { registerProgressCommands } from "./commands/progressCommands";
import { registerSCMCommands } from "./commands/scmCommands";
import { initialState, StateManager } from "./state";
import { AuthState } from "./types/state";
import { ConflictedFile } from "./git/GitService";

export interface ProjectProgressReport {
    projectId: string; // Unique project identifier
    timestamp: string; // ISO timestamp of report generation
    reportId: string; // Unique report identifier

    // Translation metrics
    translationProgress: {
        bookCompletionMap: Record<string, number>; // Book ID -> percentage complete
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
    cloneRepository: (repositoryUrl: string, cloneToPath?: string) => Promise<boolean>;
    publishWorkspace: (options: {
        name: string;
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
    syncChanges: () => Promise<{
        hasConflicts: boolean;
        conflicts?: Array<ConflictedFile>;
    }>;
    completeMerge: (resolvedFiles: ResolvedFile[]) => Promise<void>;

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
}

export interface ResolvedFile {
    filepath: string;
    resolution: "deleted" | "created" | "modified";
}

let authenticationProvider: FrontierAuthProvider;

const API_ENDPOINT = "https://api.frontierrnd.com/api/v1";
// const API_ENDPOINT = 'http://localhost:8000/api/v1';

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
    await authenticationProvider.initialize();

    // Register commands
    registerCommands(context, authenticationProvider);
    registerGitLabCommands(context, authenticationProvider);
    registerSCMCommands(context, authenticationProvider);
    registerProgressCommands(context, authenticationProvider);

    // Store API endpoint for use by other components
    context.globalState.update("frontierApiEndpoint", API_ENDPOINT);

    // Create and register status bar item immediately
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);

    // Update status bar when state changes
    stateManager.onDidChangeState(() => {
        updateStatusBar(statusBarItem, stateManager.getAuthState());
    });

    // Initial status bar update and show
    updateStatusBar(statusBarItem, stateManager.getAuthState());
    statusBarItem.show();

    // Only show activation message if not already authenticated
    if (!authenticationProvider.isAuthenticated) {
        vscode.window.showInformationMessage(
            "Frontier Authentication: Click the status bar icon to log in"
        );
    }

    // Dispose existing providers if they exist
    if (authenticationProvider) {
        // Removed dispose call here
    }

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
        cloneRepository: async (repositoryUrl: string, cloneToPath?: string) =>
            vscode.commands.executeCommand<boolean>(
                "frontier.cloneRepository",
                repositoryUrl,
                cloneToPath
            ),
        publishWorkspace: async (options: {
            name: string;
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
        syncChanges: async () =>
            vscode.commands.executeCommand("frontier.syncChanges") as Promise<{
                hasConflicts: boolean;
                conflicts?: Array<ConflictedFile>;
            }>,
        completeMerge: async (resolvedFiles: ResolvedFile[]) =>
            vscode.commands.executeCommand(
                "frontier.completeMerge",
                resolvedFiles
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

// This method is called when your extension is deactivated
export function deactivate() {
    if (authenticationProvider !== undefined) {
        authenticationProvider.dispose();
    }
}
