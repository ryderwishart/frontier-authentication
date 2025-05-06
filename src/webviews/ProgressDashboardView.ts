import * as vscode from "vscode";
import { ProjectProgressReport } from "../extension";

/**
 * Manages the progress dashboard webview panel
 */
export class ProgressDashboardView {
    public static currentPanel: ProgressDashboardView | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    /**
     * Creates and shows the progress dashboard panel
     */
    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (ProgressDashboardView.currentPanel) {
            ProgressDashboardView.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            "frontierProgressDashboard",
            "Translation Progress Dashboard",
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
            }
        );

        ProgressDashboardView.currentPanel = new ProgressDashboardView(panel, context);
    }

    /**
     * Private constructor for ProgressDashboardView
     */
    private constructor(
        panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext
    ) {
        this._panel = panel;

        // Set the webview's initial html content
        this._updateWebview();

        // Listen for when the panel is disposed (user closes it)
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Update the content if the webview is made visible
        this._panel.onDidChangeViewState(
            (e) => {
                if (this._panel.visible) {
                    this._updateWebview();
                }
            },
            null,
            this._disposables
        );

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case "refresh":
                        await this._updateProgressData();
                        break;
                    case "exportData":
                        await this._exportProgressData();
                        break;
                }
            },
            null,
            this._disposables
        );

        // Initial data load
        this._updateProgressData();
    }

    /**
     * Dispose this webview and all resources
     */
    public dispose() {
        ProgressDashboardView.currentPanel = undefined;

        // Clean up resources
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    /**
     * Update the progress data by fetching from the API
     */
    private async _updateProgressData() {
        try {
            // Show loading state
            this._panel.webview.postMessage({ type: "updateStatus", status: "loading" });

            // Fetch aggregated progress data
            const aggregateData = await vscode.commands.executeCommand(
                "frontier.getAggregatedProgress"
            );

            // Get recent reports (last 30 days, limit 10)
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const recentReports = await vscode.commands.executeCommand(
                "frontier.getProgressReports",
                {
                    startDate: thirtyDaysAgo.toISOString(),
                    limit: 10,
                }
            );

            // Update the webview with the new data
            this._panel.webview.postMessage({
                type: "updateData",
                aggregateData,
                recentReports,
            });
        } catch (error) {
            this._panel.webview.postMessage({
                type: "updateStatus",
                status: "error",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Export progress data to a JSON file
     */
    private async _exportProgressData() {
        try {
            const aggregateData = await vscode.commands.executeCommand(
                "frontier.getAggregatedProgress"
            );

            // Request a save location
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file("translation-progress.json"),
                filters: { "JSON Files": ["json"] },
            });

            if (uri) {
                // Convert data to JSON string
                const jsonData = JSON.stringify(aggregateData, null, 2);

                // Write to file
                await vscode.workspace.fs.writeFile(uri, Buffer.from(jsonData, "utf8"));

                vscode.window.showInformationMessage("Progress data exported successfully");
            }
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to export progress data: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Update the webview content
     */
    private _updateWebview() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    /**
     * Get the HTML for the webview
     */
    private _getHtmlForWebview() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Translation Progress Dashboard</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 20px;
                }
                .dashboard {
                    display: flex;
                    flex-direction: column;
                    gap: 20px;
                }
                .card {
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 4px;
                    padding: 16px;
                }
                .card-title {
                    font-size: 16px;
                    font-weight: bold;
                    margin-bottom: 12px;
                    color: var(--vscode-activityBarBadge-foreground);
                }
                .metric-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                    gap: 16px;
                }
                .metric {
                    background-color: var(--vscode-textCodeBlock-background);
                    padding: 12px;
                    border-radius: 4px;
                    display: flex;
                    flex-direction: column;
                }
                .metric-value {
                    font-size: 24px;
                    font-weight: bold;
                    margin-bottom: 4px;
                }
                .metric-label {
                    font-size: 12px;
                    opacity: 0.7;
                }
                .project-list {
                    margin-top: 12px;
                }
                .project-item {
                    display: flex;
                    justify-content: space-between;
                    padding: 8px 0;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .progress-bar {
                    height: 6px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 3px;
                    margin-top: 4px;
                    overflow: hidden;
                }
                .progress-bar-fill {
                    height: 100%;
                    background-color: var(--vscode-activityBarBadge-background);
                }
                .toolbar {
                    display: flex;
                    justify-content: flex-end;
                    margin-bottom: 16px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    border-radius: 2px;
                    cursor: pointer;
                    margin-left: 8px;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .loading {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100px;
                    font-style: italic;
                }
                .error {
                    color: var(--vscode-errorForeground);
                    padding: 12px;
                    background-color: var(--vscode-inputValidation-errorBackground);
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                    margin-bottom: 16px;
                    border-radius: 4px;
                }
            </style>
        </head>
        <body>
            <div class="dashboard">
                <div class="toolbar">
                    <button id="refreshBtn">Refresh Data</button>
                    <button id="exportBtn">Export JSON</button>
                </div>
                
                <div id="errorContainer" class="error" style="display: none;"></div>
                
                <div id="loadingIndicator" class="loading">
                    Loading progress data...
                </div>
                
                <div id="dashboardContent" style="display: none;">
                    <div class="card">
                        <div class="card-title">Overall Progress</div>
                        <div class="metric-grid">
                            <div class="metric">
                                <div class="metric-value" id="totalProjects">0</div>
                                <div class="metric-label">Total Projects</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value" id="activeProjects">0</div>
                                <div class="metric-label">Active Projects</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value" id="overallCompletion">0%</div>
                                <div class="metric-label">Overall Completion</div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="card-title">Project Status</div>
                        <div id="projectList" class="project-list">
                            <!-- Project items will be added here dynamically -->
                        </div>
                    </div>
                </div>
            </div>
            
            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    
                    // DOM elements
                    const refreshBtn = document.getElementById('refreshBtn');
                    const exportBtn = document.getElementById('exportBtn');
                    const errorContainer = document.getElementById('errorContainer');
                    const loadingIndicator = document.getElementById('loadingIndicator');
                    const dashboardContent = document.getElementById('dashboardContent');
                    
                    // Elements for metric display
                    const totalProjects = document.getElementById('totalProjects');
                    const activeProjects = document.getElementById('activeProjects');
                    const overallCompletion = document.getElementById('overallCompletion');
                    const projectList = document.getElementById('projectList');
                    
                    // Setup event listeners
                    refreshBtn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'refresh' });
                    });
                    
                    exportBtn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'exportData' });
                    });
                    
                    // Handle messages from the extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        
                        switch (message.type) {
                            case 'updateStatus':
                                if (message.status === 'loading') {
                                    loadingIndicator.style.display = 'flex';
                                    dashboardContent.style.display = 'none';
                                    errorContainer.style.display = 'none';
                                } else if (message.status === 'error') {
                                    loadingIndicator.style.display = 'none';
                                    errorContainer.textContent = message.message || 'Failed to load progress data';
                                    errorContainer.style.display = 'block';
                                }
                                break;
                                
                            case 'updateData':
                                // Hide loading indicator, show content
                                loadingIndicator.style.display = 'none';
                                dashboardContent.style.display = 'block';
                                errorContainer.style.display = 'none';
                                
                                // Update metrics
                                const aggregateData = message.aggregateData;
                                if (aggregateData) {
                                    totalProjects.textContent = aggregateData.projectCount || '0';
                                    activeProjects.textContent = aggregateData.activeProjectCount || '0';
                                    overallCompletion.textContent = \`\${Math.round(aggregateData.totalCompletionPercentage || 0)}%\`;
                                    
                                    // Update project list
                                    projectList.innerHTML = '';
                                    
                                    if (aggregateData.projectSummaries && aggregateData.projectSummaries.length) {
                                        // Sort by completion percentage (descending)
                                        aggregateData.projectSummaries.sort((a, b) => 
                                            b.completionPercentage - a.completionPercentage
                                        );
                                        
                                        aggregateData.projectSummaries.forEach(project => {
                                            const projectItem = document.createElement('div');
                                            projectItem.className = 'project-item';
                                            
                                            const lastActivity = new Date(project.lastActivity);
                                            const formattedDate = lastActivity.toLocaleDateString();
                                            
                                            projectItem.innerHTML = \`
                                                <div>
                                                    <div>\${project.projectName}</div>
                                                    <div style="font-size: 12px; opacity: 0.7;">
                                                        Last activity: \${formattedDate} | Stage: \${project.stage}
                                                    </div>
                                                    <div class="progress-bar">
                                                        <div class="progress-bar-fill" style="width: \${project.completionPercentage}%"></div>
                                                    </div>
                                                </div>
                                                <div style="font-weight: bold;">
                                                    \${Math.round(project.completionPercentage)}%
                                                </div>
                                            \`;
                                            
                                            projectList.appendChild(projectItem);
                                        });
                                    } else {
                                        projectList.innerHTML = '<div style="padding: 12px; font-style: italic;">No projects found</div>';
                                    }
                                }
                                break;
                        }
                    });
                    
                    // Initial refresh
                    vscode.postMessage({ command: 'refresh' });
                })();
            </script>
        </body>
        </html>`;
    }
}
