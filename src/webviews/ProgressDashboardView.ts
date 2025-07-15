import * as vscode from "vscode";
import { ProjectProgressReport } from "../extension";

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
                .project-card {
                    background-color: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 8px;
                    overflow: hidden;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                    margin-bottom: 16px;
                }
                .project-header {
                    padding: 20px;
                    border-bottom: 1px solid var(--vscode-widget-border);
                    background-color: var(--vscode-widget-shadow);
                }
                .project-title-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    gap: 16px;
                }
                .project-title {
                    font-size: 18px;
                    font-weight: 600;
                    margin: 0 0 4px 0;
                }
                .project-description {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                    margin: 0;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                .project-content {
                    padding: 20px;
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
                .collapsible-trigger {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    width: 100%;
                    padding: 12px 0;
                    margin-top: 8px;
                    text-align: left;
                    font-size: 14px;
                    font-weight: 500;
                    color: var(--vscode-foreground);
                }
                .collapsible-trigger:hover {
                    color: var(--vscode-textLink-activeForeground);
                }
                .collapsible-trigger-content {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .collapsible-icon {
                    font-size: 16px;
                    width: 16px;
                    height: 16px;
                }
                .chevron {
                    font-size: 16px;
                    transition: transform 0.2s;
                }
                .chevron.rotated {
                    transform: rotate(180deg);
                }
                .collapsible-content {
                    display: none;
                    padding-top: 16px;
                }
                .collapsible-content.expanded {
                    display: block;
                }
                .file-grid {
                    display: grid;
                    gap: 12px;
                }
                .file-item {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px;
                    border-radius: 6px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-widget-border);
                }
                .file-info {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .file-name {
                    font-size: 14px;
                    font-weight: 500;
                    color: var(--vscode-foreground);
                }
                .file-progress {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 4px;
                }
                .file-progress-bar {
                    height: 4px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 2px;
                    overflow: hidden;
                    width: 100%;
                }
                .file-progress-fill {
                    height: 100%;
                    background-color: var(--vscode-progressBar-foreground);
                    border-radius: 2px;
                    transition: width 0.3s ease;
                }
                .check-icon {
                    color: #16a34a;
                    font-size: 16px;
                    flex-shrink: 0;
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
                    
                    // Toggle project section expansion
                    function toggleProjectSection(projectId, section) {
                        const sectionKey = projectId + '_' + section;
                        const isExpanded = window.expandedProjects.has(sectionKey);
                        const collapsibleContent = document.querySelector(\`#\${section}-\${projectId}\`);
                        const chevron = document.querySelector(\`[data-project-id="\${projectId}"][data-section="\${section}"] .chevron\`);
                        
                        if (isExpanded) {
                            window.expandedProjects.delete(sectionKey);
                            collapsibleContent.classList.remove('expanded');
                            chevron.classList.remove('rotated');
                        } else {
                            window.expandedProjects.add(sectionKey);
                            collapsibleContent.classList.add('expanded');
                            chevron.classList.add('rotated');
                            
                            // Fetch project details if not already cached and this is details or files section
                            if (!window.projectDetailsMap.has(projectId)) {
                                vscode.postMessage({ 
                                    command: 'fetchProjectDetails', 
                                    projectId: projectId
                                });
                            }
                        }
                    }
                    
                    // Render projects as cards
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
                            const lastActivity = formatDate(project.lastActivity);
                            const completionPercentage = project.completionPercentage.toFixed(1);
                            
                            // Remove validation stage - not needed for this dashboard
                            
                            const cachedDetails = window.projectDetailsMap.get(project.projectId);
                            
                            const card = document.createElement('div');
                            card.className = 'project-card';
                            card.dataset.projectId = project.projectId;
                            
                            card.innerHTML = \`
                                <div class="project-header">
                                    <div class="project-title-row">
                                        <div>
                                            <h3 class="project-title">\${displayName}</h3>
                                            <p class="project-description">
                                                <span class="icon">🕐</span>
                                                Last updated: \${lastActivity}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                                
                                <div class="project-content">
                                    <div class="progress-overview">
                                        <div class="progress-item">
                                            <div class="progress-header">
                                                <span class="progress-label">Translation Progress</span>
                                                <span class="progress-value">\${completionPercentage}%</span>
                                            </div>
                                            <div class="progress-bar">
                                                <div class="progress-fill" style="width: \${completionPercentage}%"></div>
                                            </div>
                                            <div class="progress-text">
                                                \${cachedDetails ? 
                                                    \`\${cachedDetails.translationProgress?.translatedVerseCount || 0} / \${cachedDetails.translationProgress?.totalVerseCount || 0} verses\` :
                                                    'Loading verse count...'
                                                }
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <button class="collapsible-trigger ghost" data-project-id="\${project.projectId}" data-section="details">
                                        <div class="collapsible-trigger-content">
                                            <div class="collapsible-icon">📊</div>
                                            <span>Project Details</span>
                                        </div>
                                        <div class="chevron \${window.expandedProjects.has(project.projectId + '_details') ? 'rotated' : ''}">⌄</div>
                                    </button>
                                    
                                    <div class="collapsible-content \${window.expandedProjects.has(project.projectId + '_details') ? 'expanded' : ''}" id="details-\${project.projectId}">
                                        <div class="metrics-grid">
                                            \${cachedDetails ? \`
                                                <div class="metric-item">
                                                    <div class="metric-icon edit">✏️</div>
                                                    <div class="metric-content">
                                                        <div class="metric-value">\${cachedDetails.activityMetrics?.editCountLast24Hours || 0}</div>
                                                        <div class="metric-label">Edits (24h)</div>
                                                    </div>
                                                </div>
                                                
                                                <div class="metric-item">
                                                    <div class="metric-icon trending">📈</div>
                                                    <div class="metric-content">
                                                        <div class="metric-value">\${cachedDetails.activityMetrics?.averageDailyEdits || 0}</div>
                                                        <div class="metric-label">Avg daily edits</div>
                                                    </div>
                                                </div>
                                                
                                                <div class="metric-item">
                                                    <div class="metric-icon file">📄</div>
                                                    <div class="metric-content">
                                                        <div class="metric-value">\${(cachedDetails.translationProgress?.wordsTranslated || 0).toLocaleString()}</div>
                                                        <div class="metric-label">Words translated</div>
                                                    </div>
                                                </div>
                                            \` : \`
                                                <div style="text-align: center; padding: 20px; color: var(--vscode-descriptionForeground);">
                                                    <div class="loading-spinner" style="width: 24px; height: 24px; margin: 0 auto 12px;"></div>
                                                    Loading project details...
                                                </div>
                                            \`}
                                        </div>
                                    </div>
                                    
                                    <button class="collapsible-trigger ghost" data-project-id="\${project.projectId}" data-section="files">
                                        <div class="collapsible-trigger-content">
                                            <div class="collapsible-icon">📚</div>
                                            <span>File Progress (\${cachedDetails ? 
                                                Object.keys(cachedDetails.translationProgress?.bookCompletionMap || {}).length : 
                                                '...'
                                            } files)</span>
                                        </div>
                                        <div class="chevron \${window.expandedProjects.has(project.projectId + '_files') ? 'rotated' : ''}">⌄</div>
                                    </button>
                                    
                                    <div class="collapsible-content \${window.expandedProjects.has(project.projectId + '_files') ? 'expanded' : ''}" id="files-\${project.projectId}">
                                        <div class="file-grid">
                                            \${window.expandedProjects.has(project.projectId + '_files') && cachedDetails ? renderFileProgress(cachedDetails.translationProgress?.bookCompletionMap || {}) : 
                                                '<div style="text-align: center; padding: 20px; color: var(--vscode-descriptionForeground);">Loading file progress...</div>'
                                            }
                                        </div>
                                    </div>
                                </div>
                            \`;
                            
                            projectsContainer.appendChild(card);
                        });
                        
                        // Add event listeners to collapsible triggers
                        document.querySelectorAll('.collapsible-trigger').forEach(trigger => {
                            trigger.addEventListener('click', (e) => {
                                const projectId = e.currentTarget.dataset.projectId;
                                const section = e.currentTarget.dataset.section;
                                toggleProjectSection(projectId, section);
                            });
                        });
                    }
                    
                    // Render file progress
                    function renderFileProgress(bookCompletionMap) {
                        const books = Object.entries(bookCompletionMap)
                            .sort(([, a], [, b]) => b - a);
                        
                        return books.map(([bookCode, completion]) => \`
                            <div class="file-item">
                                <div class="file-info">
                                    <div class="file-name">\${formatBookName(bookCode)}</div>
                                    <div class="file-progress">
                                        <span>\${completion.toFixed(1)}%</span>
                                    </div>
                                    <div class="file-progress-bar">
                                        <div class="file-progress-fill" style="width: \${completion}%"></div>
                                    </div>
                                </div>
                                \${completion === 100 ? '<div class="check-icon">✓</div>' : ''}
                            </div>
                        \`).join('');
                    }
                    
                    // Update project details in UI
                    function updateProjectDetails(projectId, details) {
                        // Cache the details
                        window.projectDetailsMap.set(projectId, details);
                        
                        // Update the project card if it exists
                        const projectCard = document.querySelector(\`[data-project-id="\${projectId}"]\`);
                        if (projectCard) {
                            // Update verse count in translation progress if visible
                            const translationProgress = projectCard.querySelector('.progress-item .progress-text');
                            if (translationProgress && details.translationProgress) {
                                const verseText = details.translationProgress.translatedVerseCount + ' / ' + details.translationProgress.totalVerseCount + ' verses';
                                translationProgress.textContent = verseText;
                            }
                            
                            // Update details section if expanded
                            if (window.expandedProjects.has(projectId + '_details')) {
                                const detailsSection = document.querySelector(\`#details-\${projectId}\`);
                                if (detailsSection) {
                                    detailsSection.innerHTML = \`
                                        <div class="metrics-grid">
                                            <div class="metric-item">
                                                <div class="metric-icon edit">✏️</div>
                                                <div class="metric-content">
                                                    <div class="metric-value">\${details.activityMetrics?.editCountLast24Hours || 0}</div>
                                                    <div class="metric-label">Edits (24h)</div>
                                                </div>
                                            </div>
                                            
                                            <div class="metric-item">
                                                <div class="metric-icon trending">📈</div>
                                                <div class="metric-content">
                                                    <div class="metric-value">\${details.activityMetrics?.averageDailyEdits || 0}</div>
                                                    <div class="metric-label">Avg daily edits</div>
                                                </div>
                                            </div>
                                            
                                            <div class="metric-item">
                                                <div class="metric-icon file">📄</div>
                                                <div class="metric-content">
                                                    <div class="metric-value">\${(details.translationProgress?.wordsTranslated || 0).toLocaleString()}</div>
                                                    <div class="metric-label">Words translated</div>
                                                </div>
                                            </div>
                                        </div>
                                    \`;
                                }
                            }
                            
                            // Update file progress if expanded
                            if (window.expandedProjects.has(projectId + '_files')) {
                                const filesSection = document.querySelector(\`#files-\${projectId} .file-grid\`);
                                if (filesSection) {
                                    filesSection.innerHTML = renderFileProgress(details.translationProgress?.bookCompletionMap || {});
                                }
                            }
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
