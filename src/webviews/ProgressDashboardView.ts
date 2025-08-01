import * as vscode from "vscode";
import { ProjectProgressReport, BookCompletionData } from "../extension";

// Add interface for window with our custom properties
declare global {
    interface Window {
        projectDetailsMap: Map<string, any>;
        expandedProjects: Set<string>;
    }
}

/**
 * Manages the progress dashboard webview panel
 */
export class ProgressDashboardView {
    public static currentPanel: ProgressDashboardView | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _cachedAggregateData: any = null;
    private _lastFetchTime: number = 0;
    private _projectDetailsCache: Map<string, any> = new Map();

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
                    case "fetchProjectDetails":
                        await this._fetchProjectDetails(message.projectId);
                        break;
                    case "openProject":
                        vscode.commands.executeCommand("workbench.action.openFolder");
                        break;
                    case "createProject":
                        vscode.commands.executeCommand("workbench.action.openFolder");
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

            // Step 1: Try to get lightweight status first for fast header update
            let headerData;
            try {
                headerData = await vscode.commands.executeCommand("frontier.getProgressStatus");
                // Send header update immediately if we get fast status
                this._panel.webview.postMessage({
                    type: "updateHeader",
                    headerData: headerData,
                });
            } catch (error) {
                console.log("Status endpoint failed, will use aggregate data:", error);
            }

            // Step 2: Get full aggregated data for project summaries (this is required for dashboard)
            const aggregateData = await vscode.commands.executeCommand(
                "frontier.getAggregatedProgress"
            );

            // Get recent reports (last 30 days, limit 10)
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const recentReports = await vscode.commands.executeCommand(
                "frontier.getProgressReports",
                {
                    start_date: thirtyDaysAgo.toISOString(),
                    limit: 10,
                }
            );

            // Update the webview with the new data
            this._panel.webview.postMessage({
                type: "updateData",
                aggregateData,
                recentReports,
            });

            // Update cache after fetch
            this._cachedAggregateData = aggregateData;
            this._lastFetchTime = Date.now();
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
            // Use cached data if available, otherwise fetch fresh data
            let aggregateData = this._cachedAggregateData;
            if (!aggregateData || Date.now() - this._lastFetchTime > 300000) {
                // 5 minutes
                // Use the faster status endpoint for export, fallback to aggregated data
                try {
                    aggregateData = await vscode.commands.executeCommand(
                        "frontier.getProgressStatus"
                    );
                } catch (error) {
                    // Fallback to full aggregated data if status endpoint fails
                    aggregateData = await vscode.commands.executeCommand(
                        "frontier.getAggregatedProgress"
                    );
                }
            }

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
     * Fetch detailed project information
     */
    private async _fetchProjectDetails(projectId: string) {
        try {
            console.log(`[PROGRESS DASHBOARD] Fetching project details for ${projectId}`);

            // Send loading status update
            this._panel.webview.postMessage({
                type: "updateProjectDetailsStatus",
                projectId: projectId,
                status: "loading",
            });

            // Try the new getProjectProgress command first, fallback to getProgressReports
            let detailed: { reports: ProjectProgressReport[]; totalCount: number };
            try {
                detailed = (await vscode.commands.executeCommand(
                    "frontier.getProjectProgress",
                    projectId
                )) as { reports: ProjectProgressReport[]; totalCount: number };
            } catch (error) {
                // Fallback to the general progress reports command with updated parameter names
                detailed = (await vscode.commands.executeCommand("frontier.getProgressReports", {
                    project_ids: [projectId],
                    limit: 1,
                })) as { reports: ProjectProgressReport[]; totalCount: number };
            }

            if (detailed && detailed.reports && detailed.reports.length > 0) {
                // Store in cache
                this._projectDetailsCache.set(projectId, detailed.reports[0]);

                // Send the details back to the webview
                this._panel.webview.postMessage({
                    type: "updateProjectDetails",
                    projectId: projectId,
                    details: detailed.reports[0],
                    clearPrevious: true,
                });
            } else {
                this._panel.webview.postMessage({
                    type: "updateProjectDetailsStatus",
                    projectId: projectId,
                    status: "error",
                    message: "No data found for this project",
                });
            }
        } catch (error) {
            console.error("[PROGRESS DASHBOARD] Error fetching project details:", error);

            this._panel.webview.postMessage({
                type: "updateProjectDetailsStatus",
                projectId: projectId,
                status: "error",
                message: `Failed to load project details: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }

    /**
     * Get the HTML for the webview - modern card-based design
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
                    padding: 24px;
                    line-height: 1.6;
                    margin: 0;
                }
                .dashboard {
                    max-width: 1400px;
                    margin: 0 auto;
                    display: flex;
                    flex-direction: column;
                    gap: 24px;
                }
                .header {
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }
                .header-top {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    flex-wrap: wrap;
                    gap: 16px;
                }
                .title-section {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .title {
                    font-size: 32px;
                    font-weight: 700;
                    margin: 0;
                    letter-spacing: -0.025em;
                }
                .subtitle {
                    font-size: 16px;
                    color: var(--vscode-descriptionForeground);
                    margin: 0;
                }
                .header-actions {
                    display: flex;
                    align-items: center;
                    gap: 16px;
                }
                .search-container {
                    position: relative;
                    display: flex;
                    align-items: center;
                }
                .search-icon {
                    position: absolute;
                    left: 12px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: var(--vscode-descriptionForeground);
                    font-size: 14px;
                }
                .search-input {
                    background-color: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 6px;
                    padding: 8px 12px 8px 36px;
                    font-size: 14px;
                    color: var(--vscode-input-foreground);
                    width: 256px;
                    outline: none;
                }
                .search-input:focus {
                    border-color: var(--vscode-focusBorder);
                }
                .search-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }
                .toolbar {
                    display: flex;
                    gap: 8px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 500;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    transition: background-color 0.2s;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                button.secondary {
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-foreground);
                    border: 1px solid var(--vscode-button-border);
                }
                button.secondary:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                button.ghost {
                    background-color: transparent;
                    border: none;
                    padding: 4px 8px;
                    color: var(--vscode-foreground);
                }
                button.ghost:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .project-item {
                    background-color: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 6px;
                    overflow: hidden;
                    margin-bottom: 8px;
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
                    transition: all 0.2s ease;
                }
                .project-item:hover {
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                }
                .project-summary {
                    padding: 16px;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .project-main-info {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 16px;
                }
                .project-name {
                    font-size: 16px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    flex: 1;
                }
                .project-completion {
                    font-size: 16px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    min-width: 60px;
                    text-align: right;
                }
                .project-progress-bar {
                    height: 4px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 2px;
                    overflow: hidden;
                }
                .project-progress-fill {
                    height: 100%;
                    background-color: var(--vscode-progressBar-foreground);
                    border-radius: 2px;
                    transition: width 0.3s ease;
                }
                .expand-button {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    background-color: transparent;
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 4px;
                    padding: 8px 12px;
                    font-size: 13px;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .expand-button:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .expand-icon {
                    font-size: 14px;
                    transition: transform 0.2s ease;
                }
                .expand-icon.rotated {
                    transform: rotate(180deg);
                }
                .project-details {
                    display: none;
                    border-top: 1px solid var(--vscode-widget-border);
                    background-color: var(--vscode-editor-background);
                }
                .project-details.expanded {
                    display: block;
                }
                .project-details-content {
                    padding: 20px;
                    display: flex;
                    flex-direction: column;
                    gap: 24px;
                }
                .detail-section {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                .detail-section-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    margin: 0;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--vscode-widget-border);
                }
                .detail-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 16px;
                }
                .detail-item {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .detail-label {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    font-weight: 500;
                }
                .detail-value {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }
                .file-progress-grid {
                    display: grid;
                    gap: 8px;
                }
                .file-progress-item {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                    padding: 12px;
                    border-radius: 4px;
                    background-color: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-widget-border);
                    position: relative;
                }
                .file-progress-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    gap: 12px;
                }
                .file-name {
                    font-size: 14px;
                    font-weight: 500;
                    color: var(--vscode-foreground);
                    flex: 1;
                }
                .file-completion {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-end;
                    gap: 2px;
                }
                .file-percentage {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }
                .file-word-count {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                }
                .file-progress-bar {
                    height: 4px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 2px;
                    overflow: hidden;
                }
                .file-progress-fill {
                    height: 100%;
                    background-color: var(--vscode-progressBar-foreground);
                    border-radius: 2px;
                    transition: width 0.3s ease;
                }
                .file-complete-icon {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    color: #16a34a;
                    font-size: 16px;
                    font-weight: bold;
                }
                .progress-overview {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 16px;
                    margin-bottom: 20px;
                }
                .progress-item {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                .progress-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-size: 14px;
                }
                .progress-label {
                    color: var(--vscode-descriptionForeground);
                    font-weight: 500;
                }
                .progress-value {
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }
                .progress-bar {
                    height: 6px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 3px;
                    overflow: hidden;
                    position: relative;
                }
                .progress-fill {
                    height: 100%;
                    background-color: var(--vscode-progressBar-foreground);
                    border-radius: 3px;
                    transition: width 0.3s ease;
                }
                .progress-text {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 2px;
                }
                .metrics-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
                    gap: 16px;
                    padding: 16px 0;
                    border-top: 1px solid var(--vscode-widget-border);
                }
                .metric-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .metric-icon {
                    font-size: 16px;
                    width: 16px;
                    height: 16px;
                    flex-shrink: 0;
                }
                .metric-icon.edit { color: #3b82f6; }
                .metric-icon.trending { color: #16a34a; }
                .metric-icon.alert { color: #f97316; }
                .metric-icon.file { color: #8b5cf6; }
                .metric-content {
                    display: flex;
                    flex-direction: column;
                }
                .metric-value {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }
                .metric-label {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }

                .loading {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 60px 20px;
                    color: var(--vscode-descriptionForeground);
                }
                .loading-spinner {
                    border: 3px solid var(--vscode-progressBar-background);
                    border-radius: 50%;
                    border-top: 3px solid var(--vscode-progressBar-foreground);
                    width: 32px;
                    height: 32px;
                    animation: spin 1s linear infinite;
                    margin-bottom: 16px;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .error {
                    color: var(--vscode-errorForeground);
                    padding: 16px;
                    background-color: var(--vscode-inputValidation-errorBackground);
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                    border-radius: 6px;
                    margin-bottom: 16px;
                }
                .empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 60px 20px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                }
                .empty-state-icon {
                    font-size: 48px;
                    margin-bottom: 16px;
                    color: var(--vscode-descriptionForeground);
                }
                .empty-state-title {
                    font-size: 18px;
                    font-weight: 500;
                    margin-bottom: 8px;
                }
                .empty-state-description {
                    font-size: 14px;
                    margin-bottom: 16px;
                }
                .hidden {
                    display: none !important;
                }
                .icon {
                    display: inline-block;
                    width: 16px;
                    height: 16px;
                    text-align: center;
                    font-size: 16px;
                    line-height: 1;
                }
                @media (max-width: 768px) {
                    .header-top {
                        flex-direction: column;
                        align-items: stretch;
                    }
                    .header-actions {
                        flex-direction: column;
                        align-items: stretch;
                    }
                    .search-input {
                        width: 100%;
                    }
                    .progress-overview {
                        grid-template-columns: 1fr;
                    }
                    .metrics-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }
                }
            </style>
        </head>
        <body>
            <div class="dashboard">
                <div class="header">
                    <div class="header-top">
                        <div class="title-section">
                            <h1 class="title">Translation Projects</h1>
                            <p class="subtitle">Monitor progress across all your translation projects</p>
                        </div>
                        <div class="header-actions">
                            <div class="search-container">
                                <span class="search-icon">🔍</span>
                                <input type="text" class="search-input" id="searchInput" placeholder="Search projects...">
                            </div>
                            <div class="toolbar">
                                <button id="refreshBtn">
                                    <span>↻</span> Refresh
                                </button>
                                <button id="exportBtn" class="secondary">
                                    <span>↓</span> Export
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div id="errorContainer" class="error hidden"></div>
                
                <div id="loadingIndicator" class="loading">
                    <div class="loading-spinner"></div>
                    <div>Loading translation progress data...</div>
                </div>
                
                <div id="dashboardContent" class="hidden">
                    <div id="projectsContainer">
                        <!-- Project cards will be added here -->
                    </div>
                    
                    <div id="emptyProjectsState" class="empty-state hidden">
                        <div class="empty-state-icon">📚</div>
                        <h3 class="empty-state-title">No projects found</h3>
                        <p class="empty-state-description">Try adjusting your search terms</p>
                    </div>
                </div>
            </div>
            
            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    
                    // Initialize project tracking
                    window.projectDetailsMap = new Map();
                    window.expandedProjects = new Set();
                    let currentProjects = [];
                    
                    // DOM elements
                    const refreshBtn = document.getElementById('refreshBtn');
                    const exportBtn = document.getElementById('exportBtn');
                    const errorContainer = document.getElementById('errorContainer');
                    const loadingIndicator = document.getElementById('loadingIndicator');
                    const dashboardContent = document.getElementById('dashboardContent');
                    const emptyProjectsState = document.getElementById('emptyProjectsState');
                    const projectsContainer = document.getElementById('projectsContainer');
                    const searchInput = document.getElementById('searchInput');
                    
                    // Setup event listeners
                    refreshBtn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'refresh' });
                    });
                    
                    exportBtn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'exportData' });
                    });
                    
                    // Search functionality
                    searchInput.addEventListener('input', (e) => {
                        const searchTerm = e.target.value.toLowerCase();
                        const filteredProjects = currentProjects.filter(project => 
                            project.projectName.toLowerCase().includes(searchTerm) ||
                            getDisplayName(project).toLowerCase().includes(searchTerm)
                        );
                        renderProjects(filteredProjects);
                    });
                    
                    // Format date for better display
                    function formatDate(dateString) {
                        if (!dateString) return 'Unknown';
                        
                        try {
                            const date = new Date(dateString);
                            
                            // Check if date is valid
                            if (isNaN(date.getTime())) {
                                return 'Invalid date';
                            }
                            
                            const now = new Date();
                            const diffMs = now - date;
                            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                            
                            // Handle future dates (likely data errors)
                            if (diffMs < 0) {
                                return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' (future date)';
                            }
                            
                            if (diffDays === 0) {
                                return 'Today, ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            } else if (diffDays === 1) {
                                return 'Yesterday, ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            } else if (diffDays < 7) {
                                return diffDays + ' days ago';
                            } else {
                                return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
                            }
                        } catch (error) {
                            console.error('Error formatting date:', dateString, error);
                            return 'Invalid date';
                        }
                    }
                    
                    // Get human readable project name
                    function getDisplayName(project) {
                        // Extract language name from project ID if possible
                        const nameParts = project.projectName.split('-');
                        if (nameParts.length > 1) {
                            // If project name follows pattern like "tok-pisin-reference-4k7a4g6alkxqsyqvv5oyw"
                            // Extract the language part without the ID
                            const langParts = nameParts.filter(part => !part.match(/[0-9]/));
                            if (langParts.length > 0) {
                                return langParts.join(' ').replace(/\\b\\w/g, l => l.toUpperCase());
                            }
                        }
                        return project.projectName;
                    }
                    

                    
                    // Format book name for display
                    function formatBookName(bookCode) {
                        return bookCode.replace(/_en$/, '').replace(/TheChosen_/, 'Episode ');
                    }
                    
                    // Toggle project expansion
                    function toggleProjectExpansion(projectId) {
                        const isExpanded = window.expandedProjects.has(projectId);
                        const projectDetails = document.querySelector(\`#project-details-\${projectId}\`);
                        const expandIcon = document.querySelector(\`[data-project-id="\${projectId}"] .expand-icon\`);
                        
                        if (isExpanded) {
                            window.expandedProjects.delete(projectId);
                            projectDetails.classList.remove('expanded');
                            expandIcon.classList.remove('rotated');
                        } else {
                            window.expandedProjects.add(projectId);
                            projectDetails.classList.add('expanded');
                            expandIcon.classList.add('rotated');
                            
                            // Fetch project details if not already cached
                            if (!window.projectDetailsMap.has(projectId)) {
                                vscode.postMessage({ 
                                    command: 'fetchProjectDetails', 
                                    projectId: projectId
                                });
                            } else {
                                // Update the details view with cached data
                                updateProjectDetailsView(projectId, window.projectDetailsMap.get(projectId));
                            }
                        }
                    }
                    
                    // Render projects as concise list
                    function renderProjects(projects) {
                        projectsContainer.innerHTML = '';
                        
                        if (!projects || projects.length === 0) {
                            emptyProjectsState.classList.remove('hidden');
                            return;
                        }
                        
                        emptyProjectsState.classList.add('hidden');
                        
                        projects.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
                        
                        projects.forEach(project => {
                            const displayName = getDisplayName(project);
                            const completionPercentage = project.completionPercentage.toFixed(1);
                            
                            const projectItem = document.createElement('div');
                            projectItem.className = 'project-item';
                            projectItem.dataset.projectId = project.projectId;
                            
                            projectItem.innerHTML = \`
                                <div class="project-summary">
                                    <div class="project-main-info">
                                        <div class="project-name">\${displayName}</div>
                                        <div class="project-completion">\${completionPercentage}%</div>
                                    </div>
                                    <div class="project-progress-bar">
                                        <div class="project-progress-fill" style="width: \${completionPercentage}%"></div>
                                    </div>
                                    <button class="expand-button ghost" data-project-id="\${project.projectId}">
                                        <span class="expand-icon">⌄</span>
                                        <span>View Details</span>
                                    </button>
                                </div>
                                
                                <div class="project-details \${window.expandedProjects.has(project.projectId) ? 'expanded' : ''}" id="project-details-\${project.projectId}">
                                    <div class="details-loading" style="text-align: center; padding: 20px; color: var(--vscode-descriptionForeground);">
                                        <div class="loading-spinner" style="width: 24px; height: 24px; margin: 0 auto 12px;"></div>
                                        Loading project details...
                                    </div>
                                </div>
                            \`;
                            
                            projectsContainer.appendChild(projectItem);
                        });
                        
                        // Add event listeners to expand buttons
                        document.querySelectorAll('.expand-button').forEach(button => {
                            button.addEventListener('click', (e) => {
                                const projectId = e.currentTarget.dataset.projectId;
                                toggleProjectExpansion(projectId);
                            });
                        });
                    }
                    
                    // Helper function to extract completion data (supports both old and new formats)
                    function getCompletionData(data) {
                        if (typeof data === 'number') {
                            // Legacy format - just percentage
                            return {
                                completionPercentage: data,
                                sourceWords: null,
                                targetWords: null
                            };
                        } else if (data && typeof data === 'object') {
                            // New format - object with word counts
                            return {
                                completionPercentage: data.completionPercentage || 0,
                                sourceWords: data.sourceWords || 0,
                                targetWords: data.targetWords || 0
                            };
                        }
                        return { completionPercentage: 0, sourceWords: null, targetWords: null };
                    }

                    // Render file progress
                    function renderFileProgress(bookCompletionMap) {
                        const books = Object.entries(bookCompletionMap)
                            .sort(([, a], [, b]) => {
                                const aData = getCompletionData(a);
                                const bData = getCompletionData(b);
                                return bData.completionPercentage - aData.completionPercentage;
                            });
                        
                        return books.map(([bookCode, completionData]) => {
                            const data = getCompletionData(completionData);
                            const percentage = data.completionPercentage;
                            const hasWordCounts = data.sourceWords !== null && data.targetWords !== null;
                            
                            return \`
                                <div class="file-progress-item">
                                    <div class="file-progress-header">
                                        <span class="file-name">\${formatBookName(bookCode)}</span>
                                        <div class="file-completion">
                                            <span class="file-percentage">\${percentage.toFixed(1)}%</span>
                                            \${hasWordCounts ? 
                                                \`<span class="file-word-count">
                                                    \${data.targetWords.toLocaleString()} / \${data.sourceWords.toLocaleString()} words
                                                </span>\` : ''
                                            }
                                        </div>
                                    </div>
                                    <div class="file-progress-bar">
                                        <div class="file-progress-fill" style="width: \${percentage}%"></div>
                                    </div>
                                    \${percentage === 100 ? '<div class="file-complete-icon">✓</div>' : ''}
                                </div>
                            \`;
                        }).join('');
                    }
                    
                    // Update project details view
                    function updateProjectDetailsView(projectId, details) {
                        const projectDetailsContainer = document.querySelector(\`#project-details-\${projectId}\`);
                        if (!projectDetailsContainer) return;
                        
                        const lastActivity = formatDate(details.timestamp);
                        
                        projectDetailsContainer.innerHTML = \`
                            <div class="project-details-content">
                                <div class="detail-section">
                                    <h4 class="detail-section-title">📊 Progress Overview</h4>
                                    <div class="detail-grid">
                                        <div class="detail-item">
                                            <span class="detail-label">Total Verses</span>
                                            <span class="detail-value">\${(details.translationProgress?.totalVerseCount || 0).toLocaleString()}</span>
                                        </div>
                                        <div class="detail-item">
                                            <span class="detail-label">Translated</span>
                                            <span class="detail-value">\${(details.translationProgress?.translatedVerseCount || 0).toLocaleString()}</span>
                                        </div>
                                        <div class="detail-item">
                                            <span class="detail-label">Validated</span>
                                            <span class="detail-value">\${(details.translationProgress?.validatedVerseCount || 0).toLocaleString()}</span>
                                        </div>
                                        <div class="detail-item">
                                            <span class="detail-label">Words Translated</span>
                                            <span class="detail-value">\${(details.translationProgress?.wordsTranslated || 0).toLocaleString()}</span>
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="detail-section">
                                    <h4 class="detail-section-title">⚡ Activity</h4>
                                    <div class="detail-grid">
                                        <div class="detail-item">
                                            <span class="detail-label">Last Update</span>
                                            <span class="detail-value">\${lastActivity}</span>
                                        </div>
                                        <div class="detail-item">
                                            <span class="detail-label">Edits (24h)</span>
                                            <span class="detail-value">\${details.activityMetrics?.editCountLast24Hours || 0}</span>
                                        </div>
                                        <div class="detail-item">
                                            <span class="detail-label">Edits (7d)</span>
                                            <span class="detail-value">\${details.activityMetrics?.editCountLastWeek || 0}</span>
                                        </div>
                                        <div class="detail-item">
                                            <span class="detail-label">Avg Daily</span>
                                            <span class="detail-value">\${details.activityMetrics?.averageDailyEdits || 0}</span>
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="detail-section">
                                    <h4 class="detail-section-title">📚 File Progress</h4>
                                    <div class="file-progress-grid">
                                        \${renderFileProgress(details.translationProgress?.bookCompletionMap || {})}
                                    </div>
                                </div>
                            </div>
                        \`;
                    }
                    
                    // Update project details in UI
                    function updateProjectDetails(projectId, details) {
                        // Cache the details
                        window.projectDetailsMap.set(projectId, details);
                        
                        // Update the details view if project is expanded
                        if (window.expandedProjects.has(projectId)) {
                            updateProjectDetailsView(projectId, details);
                        }
                    }
                    
                    // Handle messages from the extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        
                        switch (message.type) {
                            case 'updateStatus':
                                if (message.status === 'loading') {
                                    loadingIndicator.classList.remove('hidden');
                                    dashboardContent.classList.add('hidden');
                                    errorContainer.classList.add('hidden');
                                } else if (message.status === 'error') {
                                    loadingIndicator.classList.add('hidden');
                                    errorContainer.textContent = message.message || 'Failed to load progress data';
                                    errorContainer.classList.remove('hidden');
                                }
                                break;
                                
                            case 'updateHeader':
                                // Quick header update with metrics - keep loading indicator visible
                                const headerData = message.headerData;
                                if (headerData) {
                                    // Update the subtitle with quick metrics
                                    const subtitle = document.querySelector('.subtitle');
                                    if (subtitle) {
                                        subtitle.textContent = headerData.projectCount + ' projects • ' + headerData.activeProjectCount + ' active • ' + headerData.totalCompletionPercentage + '% average completion';
                                    }
                                }
                                break;
                                
                            case 'updateData':
                                // Hide loading indicator, show content
                                loadingIndicator.classList.add('hidden');
                                dashboardContent.classList.remove('hidden');
                                errorContainer.classList.add('hidden');
                                
                                // Update UI
                                const aggregateData = message.aggregateData;
                                if (aggregateData && aggregateData.projectSummaries) {
                                    currentProjects = aggregateData.projectSummaries;
                                    renderProjects(currentProjects);
                                }
                                break;
                                
                            case 'updateProjectDetails':
                                if (message.projectId && message.details) {
                                    updateProjectDetails(message.projectId, message.details);
                                }
                                break;
                                
                            case 'updateProjectDetailsStatus':
                                if (message.status === 'error') {
                                    console.error('Error loading project details:', message.message);
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
