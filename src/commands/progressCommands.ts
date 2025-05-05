import * as vscode from "vscode";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";
import { ProjectProgressReport } from "../extension";

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
}
