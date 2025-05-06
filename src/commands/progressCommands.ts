import * as vscode from "vscode";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";
import { ProjectProgressReport } from "../extension";
import { ProgressDashboardView } from "../webviews/ProgressDashboardView";

/**
 * Register commands related to project progress reporting
 */
export function registerProgressCommands(
    context: vscode.ExtensionContext,
    authProvider: FrontierAuthProvider
) {
    // Submit a progress report
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "frontier.submitProgressReport",
            async (report: ProjectProgressReport) => {
                try {
                    if (!authProvider.isAuthenticated) {
                        throw new Error("You must be logged in to submit progress reports");
                    }

                    // Get authenticated session
                    const sessions = await authProvider.getSessions();
                    const session = sessions[0];
                    if (!session) {
                        throw new Error("Authentication session expired");
                    }

                    // We need to know the API endpoint from the auth provider
                    // Since apiEndpoint is private, we'll get it from the context
                    const apiEndpoint = context.globalState.get<string>("frontierApiEndpoint");
                    if (!apiEndpoint) {
                        throw new Error("API endpoint is not configured");
                    }

                    // POST to API endpoint
                    const response = await fetch(`${apiEndpoint}/projects/progress`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${session.accessToken}`,
                        },
                        body: JSON.stringify(report),
                    });

                    if (!response.ok) {
                        const errorData = await response.json();
                        throw new Error(
                            `Failed to submit progress report: ${errorData.message || response.statusText}`
                        );
                    }

                    const result = await response.json();
                    return {
                        success: true,
                        reportId: result.reportId,
                    };
                } catch (error) {
                    console.error("Error submitting progress report:", error);
                    vscode.window.showErrorMessage(
                        `Failed to submit progress report: ${error instanceof Error ? error.message : String(error)}`
                    );
                    return {
                        success: false,
                        reportId: "",
                    };
                }
            }
        )
    );

    // Get progress reports
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "frontier.getProgressReports",
            async (options: {
                projectIds?: string[];
                startDate?: string;
                endDate?: string;
                limit?: number;
                offset?: number;
            }) => {
                try {
                    if (!authProvider.isAuthenticated) {
                        throw new Error("You must be logged in to retrieve progress reports");
                    }

                    // Get authenticated session
                    const sessions = await authProvider.getSessions();
                    const session = sessions[0];
                    if (!session) {
                        throw new Error("Authentication session expired");
                    }

                    // Get API endpoint from context
                    const apiEndpoint = context.globalState.get<string>("frontierApiEndpoint");
                    if (!apiEndpoint) {
                        throw new Error("API endpoint is not configured");
                    }

                    // Construct query parameters
                    const params = new URLSearchParams();
                    if (options.projectIds && options.projectIds.length > 0) {
                        options.projectIds.forEach((id) => params.append("projectId", id));
                    }
                    if (options.startDate) {
                        params.set("startDate", options.startDate);
                    }
                    if (options.endDate) {
                        params.set("endDate", options.endDate);
                    }
                    if (options.limit) {
                        params.set("limit", options.limit.toString());
                    }
                    if (options.offset) {
                        params.set("offset", options.offset.toString());
                    }

                    // GET from API endpoint
                    const response = await fetch(
                        `${apiEndpoint}/projects/progress?${params.toString()}`,
                        {
                            method: "GET",
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                        }
                    );

                    if (!response.ok) {
                        const errorData = await response.json();
                        throw new Error(
                            `Failed to get progress reports: ${errorData.message || response.statusText}`
                        );
                    }

                    return await response.json();
                } catch (error) {
                    console.error("Error getting progress reports:", error);
                    vscode.window.showErrorMessage(
                        `Failed to get progress reports: ${error instanceof Error ? error.message : String(error)}`
                    );
                    return {
                        reports: [],
                        totalCount: 0,
                    };
                }
            }
        )
    );

    // Get aggregated progress
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.getAggregatedProgress", async () => {
            try {
                if (!authProvider.isAuthenticated) {
                    throw new Error("You must be logged in to retrieve aggregated progress");
                }

                // Get authenticated session
                const sessions = await authProvider.getSessions();
                const session = sessions[0];
                if (!session) {
                    throw new Error("Authentication session expired");
                }

                // Get API endpoint from context
                const apiEndpoint = context.globalState.get<string>("frontierApiEndpoint");
                if (!apiEndpoint) {
                    throw new Error("API endpoint is not configured");
                }

                // GET from API endpoint
                const response = await fetch(`${apiEndpoint}/projects/progress/aggregate`, {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${session.accessToken}`,
                    },
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(
                        `Failed to get aggregated progress: ${errorData.message || response.statusText}`
                    );
                }

                return await response.json();
            } catch (error) {
                console.error("Error getting aggregated progress:", error);
                vscode.window.showErrorMessage(
                    `Failed to get aggregated progress: ${error instanceof Error ? error.message : String(error)}`
                );
                return {
                    projectCount: 0,
                    activeProjectCount: 0,
                    totalCompletionPercentage: 0,
                    projectSummaries: [],
                };
            }
        })
    );

    // Add a manual refresh command for progress data
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.refreshProgressData", async () => {
            try {
                // If dashboard is open, opening it again will just bring it to focus
                ProgressDashboardView.createOrShow(context);

                const result = await vscode.commands.executeCommand(
                    "frontier.getAggregatedProgress"
                );
                return result;
            } catch (error) {
                console.error("Error refreshing progress data:", error);
                vscode.window.showErrorMessage(
                    `Failed to refresh progress data: ${error instanceof Error ? error.message : String(error)}`
                );
                return null;
            }
        })
    );

    // Show progress dashboard
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.showProgressDashboard", () => {
            // Open the dashboard view
            ProgressDashboardView.createOrShow(context);
        })
    );

    // Debug auth status (helpful for troubleshooting API issues)
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.debugAuth", async () => {
            try {
                if (!authProvider.isAuthenticated) {
                    vscode.window.showInformationMessage("Not authenticated");
                    return;
                }

                const sessions = await authProvider.getSessions();
                const session = sessions[0];

                if (!session) {
                    vscode.window.showInformationMessage("No active session found");
                    return;
                }

                // Show basic info without exposing the full token
                const info = {
                    user: session.account.label,
                    scopes: session.scopes,
                    tokenPreview: session.accessToken.substring(0, 8) + "...",
                    apiEndpoint: context.globalState.get<string>("frontierApiEndpoint"),
                };

                // Create a temporary output channel to show the debug info
                const channel = vscode.window.createOutputChannel("Frontier Auth Debug");
                channel.appendLine(JSON.stringify(info, null, 2));
                channel.show();

                vscode.window.showInformationMessage(
                    "Auth debug info has been output to the 'Frontier Auth Debug' channel"
                );
            } catch (error) {
                console.error("Error debugging auth:", error);
                vscode.window.showErrorMessage(
                    `Failed to debug auth: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        })
    );

    // Add test progress report command
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.testProgressReport", async () => {
            try {
                if (!authProvider.isAuthenticated) {
                    vscode.window.showErrorMessage("You must be logged in to submit test reports");
                    return;
                }

                // Get a list of projects the user has access to
                let projectId = "";
                let projectName = "Test Project";

                try {
                    // First try to get actual projects from the API
                    const projects = (await vscode.commands.executeCommand(
                        "frontier.listProjects",
                        {
                            showUI: false,
                        }
                    )) as Array<{
                        id: number;
                        name: string;
                        description: string | null;
                    }>;

                    if (projects && projects.length > 0) {
                        // Let user pick a project
                        const projectItems = projects.map((p) => ({
                            label: p.name,
                            description: p.description || "",
                            id: p.id.toString(),
                        }));

                        const selected = await vscode.window.showQuickPick(projectItems, {
                            placeHolder: "Select a project for the test report",
                            title: "Available Projects",
                        });

                        if (selected) {
                            projectId = selected.id;
                            projectName = selected.label;
                        }
                    }
                } catch (e) {
                    console.error("Failed to get projects list:", e);
                }

                // If we couldn't get a project from the API, use the test project ID
                if (!projectId) {
                    // Use the default test project ID from API docs
                    const defaultTestId = "tok-pisin-reference-4k7a4g6alkxqsyqvv5oyw";

                    projectId =
                        (await vscode.window.showInputBox({
                            prompt: "Enter a project ID for the test report",
                            placeHolder: "Project ID",
                            value: defaultTestId,
                        })) || defaultTestId;

                    projectName = "Test Project";
                }

                // Create a sample progress report matching the expected format
                const now = new Date();
                const sampleReport: ProjectProgressReport = {
                    projectId: projectId,
                    timestamp: now.toISOString(),
                    reportId: `test-${Date.now()}`,

                    translationProgress: {
                        bookCompletionMap: {
                            GEN: 75.42,
                            EXO: 45.21,
                            LEV: 20.78,
                        },
                        totalVerseCount: 5000,
                        translatedVerseCount: 2500,
                        validatedVerseCount: 1200,
                        wordsTranslated: 35000,
                    },

                    validationStatus: {
                        stage: "community",
                        versesPerStage: {
                            none: 2500,
                            initial: 1500,
                            community: 800,
                            expert: 200,
                            finished: 0,
                        },
                        lastValidationTimestamp: new Date(now.getTime() - 86400000).toISOString(),
                    },

                    activityMetrics: {
                        lastEditTimestamp: new Date(now.getTime() - 3600000).toISOString(),
                        editCountLast24Hours: 120,
                        editCountLastWeek: 450,
                        averageDailyEdits: 75,
                    },

                    qualityMetrics: {
                        spellcheckIssueCount: 15,
                        flaggedSegmentsCount: 8,
                        consistencyScore: 85,
                    },
                };

                // Show test report details
                const detail = `Submitting test report for project: ${projectName} (ID: ${projectId})`;
                vscode.window.showInformationMessage(detail);

                // Submit the report
                const result = (await vscode.commands.executeCommand(
                    "frontier.submitProgressReport",
                    sampleReport
                )) as { success: boolean; reportId: string };

                if (result.success) {
                    vscode.window.showInformationMessage(
                        `Test report submitted successfully with ID: ${result.reportId}`
                    );
                } else {
                    throw new Error("Failed to submit test report");
                }
            } catch (error) {
                console.error("Error submitting test report:", error);
                vscode.window.showErrorMessage(
                    `Failed to submit test report: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        })
    );

    // Manual progress report submission
    context.subscriptions.push(
        vscode.commands.registerCommand("frontier.manualSubmitProgressReport", async () => {
            try {
                if (!authProvider.isAuthenticated) {
                    vscode.window.showErrorMessage(
                        "You must be logged in to submit progress reports"
                    );
                    return;
                }

                // Get a list of projects the user has access to
                let projectId = "";
                let projectName = "Manual Project";
                let validGitlabProject = false;

                try {
                    // Get actual projects from the API
                    const projects = (await vscode.commands.executeCommand(
                        "frontier.listProjects",
                        { showUI: false }
                    )) as Array<{ id: number; name: string; description: string | null }>;

                    if (projects && projects.length > 0) {
                        // Let user pick a project
                        const projectItems = projects.map((p) => ({
                            label: p.name,
                            description: p.description || "",
                            id: p.id.toString(),
                        }));

                        const selected = await vscode.window.showQuickPick(projectItems, {
                            placeHolder: "Select a project for the progress report",
                            title: "Available Projects",
                        });

                        if (selected) {
                            projectId = selected.id;
                            projectName = selected.label;
                            validGitlabProject = true;
                        } else {
                            // User cancelled project selection
                            return;
                        }
                    }
                } catch (e) {
                    console.error("Failed to get projects list:", e);
                }

                // If we couldn't get a project from the API, abort with a clear message
                if (!validGitlabProject) {
                    vscode.window.showErrorMessage(
                        "Cannot create progress report: No valid GitLab project selected. Please ensure you have access to GitLab projects."
                    );
                    return;
                }

                // Get book completion input
                const bookInput = await vscode.window.showInputBox({
                    prompt: "Enter book codes and completion percentages",
                    placeHolder: "GEN:75.42,EXO:45.21,LEV:20.78",
                    value: "GEN:75.42,EXO:45.21,LEV:20.78",
                });

                if (!bookInput) {
                    // User cancelled
                    return;
                }

                // Parse book completion map
                const bookCompletionMap: Record<string, number> = {};
                try {
                    bookInput.split(",").forEach((entry) => {
                        const [book, percentage] = entry.trim().split(":");
                        bookCompletionMap[book] = Number(percentage);
                    });
                } catch (e) {
                    vscode.window.showErrorMessage(
                        "Invalid book completion format. Use format 'BOOK:PERCENTAGE,BOOK:PERCENTAGE'"
                    );
                    return;
                }

                // Get verse counts
                const totalVerseCount = Number(
                    (await vscode.window.showInputBox({
                        prompt: "Enter total verse count",
                        placeHolder: "Total verses in project",
                        value: "5000",
                    })) || "5000"
                );

                const translatedVerseCount = Number(
                    (await vscode.window.showInputBox({
                        prompt: "Enter translated verse count",
                        placeHolder: "Verses with translations",
                        value: "2500",
                    })) || "2500"
                );

                const validatedVerseCount = Number(
                    (await vscode.window.showInputBox({
                        prompt: "Enter validated verse count",
                        placeHolder: "Verses passing validation",
                        value: "1200",
                    })) || "1200"
                );

                const wordsTranslated = Number(
                    (await vscode.window.showInputBox({
                        prompt: "Enter total words translated",
                        placeHolder: "Word count",
                        value: "35000",
                    })) || "35000"
                );

                // Get validation status
                const stageOptions = ["none", "initial", "community", "expert", "finished"];
                const stageResult = await vscode.window.showQuickPick(stageOptions, {
                    placeHolder: "Select validation stage",
                    title: "Validation Stage",
                });

                // Default to "community" if user cancels
                let stage: "none" | "initial" | "community" | "expert" | "finished" = "community";
                if (stageResult === "none") {
                    stage = "none";
                } else if (stageResult === "initial") {
                    stage = "initial";
                } else if (stageResult === "community") {
                    stage = "community";
                } else if (stageResult === "expert") {
                    stage = "expert";
                } else if (stageResult === "finished") {
                    stage = "finished";
                }

                // Create a sample progress report
                const now = new Date();
                const progressReport: ProjectProgressReport = {
                    projectId: projectId,
                    timestamp: now.toISOString(),
                    reportId: `manual-${Date.now()}`,

                    translationProgress: {
                        bookCompletionMap,
                        totalVerseCount,
                        translatedVerseCount,
                        validatedVerseCount,
                        wordsTranslated,
                    },

                    validationStatus: {
                        stage,
                        versesPerStage: {
                            none: 2500,
                            initial: 1500,
                            community: 800,
                            expert: 200,
                            finished: 0,
                        },
                        lastValidationTimestamp: new Date(now.getTime() - 86400000).toISOString(),
                    },

                    activityMetrics: {
                        lastEditTimestamp: new Date(now.getTime() - 3600000).toISOString(),
                        editCountLast24Hours: 120,
                        editCountLastWeek: 450,
                        averageDailyEdits: 75,
                    },

                    qualityMetrics: {
                        spellcheckIssueCount: 15,
                        flaggedSegmentsCount: 8,
                        consistencyScore: 85,
                    },
                };

                // Format the JSON for display
                const formattedJson = JSON.stringify(progressReport, null, 2);

                // Create output channel to show the JSON
                const channel = vscode.window.createOutputChannel("Progress Report Preview");
                channel.clear();
                channel.appendLine("Progress Report to be submitted:");
                channel.appendLine(formattedJson);
                channel.show();

                // Show confirmation dialog
                const confirmation = await vscode.window.showInformationMessage(
                    `Confirm submission of progress report for ${projectName}?`,
                    "Submit",
                    "Cancel"
                );

                if (confirmation !== "Submit") {
                    vscode.window.showInformationMessage("Progress report submission cancelled");
                    return;
                }

                // Submit the report
                console.log("Submitting progress report:", JSON.stringify(progressReport));
                const result = (await vscode.commands.executeCommand(
                    "frontier.submitProgressReport",
                    progressReport
                )) as { success: boolean; reportId: string };

                if (result.success) {
                    vscode.window.showInformationMessage(
                        `Progress report submitted successfully with ID: ${result.reportId}`
                    );
                } else {
                    throw new Error("Failed to submit progress report");
                }
            } catch (error) {
                console.error("Error manually submitting progress report:", error);
                vscode.window.showErrorMessage(
                    `Failed to submit progress report: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        })
    );
}
