import * as vscode from "vscode";
import { ProjectProgressReport } from "../extension";

/**
 * Manages the progress dashboard webview panel
 */
export class ProgressDashboardView {
    public static currentPanel: ProgressDashboardView | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _cachedAggregateData: any = null;
    private _lastFetchTime: number = 0;

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
                    line-height: 1.5;
                }
                .dashboard {
                    display: flex;
                    flex-direction: column;
                    gap: 24px;
                    max-width: 1200px;
                    margin: 0 auto;
                }
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                }
                .title {
                    font-size: 20px;
                    font-weight: 600;
                }
                .card {
                    background-color: var(--vscode-widget-shadow);
                    border-radius: 8px;
                    padding: 24px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
                    transition: all 0.2s ease;
                }
                .card-title {
                    font-size: 16px;
                    font-weight: 600;
                    margin-bottom: 16px;
                    color: var(--vscode-editor-foreground);
                }
                .metric-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                    gap: 24px;
                }
                .metric {
                    background-color: var(--vscode-editor-background);
                    padding: 16px;
                    border-radius: 8px;
                    display: flex;
                    flex-direction: column;
                    border: 1px solid var(--vscode-widget-border);
                }
                .metric-value {
                    font-size: 32px;
                    font-weight: 700;
                    margin-bottom: 8px;
                    color: var(--vscode-textLink-activeForeground);
                }
                .metric-label {
                    font-size: 13px;
                    color: var(--vscode-descriptionForeground);
                }
                .project-list {
                    margin-top: 16px;
                }
                .project-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 16px;
                    margin-bottom: 12px;
                    border-radius: 8px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-widget-border);
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .project-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .project-item-expanded {
                    border-color: var(--vscode-focusBorder);
                }
                .project-info {
                    flex: 1;
                }
                .project-name {
                    font-weight: 600;
                    margin-bottom: 4px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .project-trend {
                    display: inline-flex;
                    align-items: center;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 600;
                    margin-left: 8px;
                }
                .trend-up {
                    background-color: rgba(80, 200, 120, 0.2);
                    color: rgb(80, 200, 120);
                }
                .trend-down {
                    background-color: rgba(255, 99, 71, 0.2);
                    color: rgb(255, 99, 71);
                }
                .project-meta {
                    font-size: 13px;
                    color: var(--vscode-descriptionForeground);
                    display: flex;
                    align-items: center;
                    gap: 16px;
                }
                .project-completion {
                    min-width: 80px;
                    text-align: right;
                    font-weight: 700;
                    font-size: 20px;
                    color: var(--vscode-charts-blue);
                }
                .progress-bar {
                    height: 8px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 4px;
                    margin-top: 8px;
                    overflow: hidden;
                }
                .progress-bar-fill {
                    height: 100%;
                    background-color: var(--vscode-progressBar-foreground);
                    border-radius: 4px;
                    transition: width 0.5s ease;
                }
                .toolbar {
                    display: flex;
                    gap: 12px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-weight: 500;
                    transition: background-color 0.2s;
                    display: flex;
                    align-items: center;
                    gap: 6px;
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
                .icon {
                    width: 16px;
                    height: 16px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                }
                .loading {
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    height: 200px;
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                }
                .loading-spinner {
                    border: 3px solid rgba(0, 0, 0, 0.1);
                    border-radius: 50%;
                    border-top: 3px solid var(--vscode-progressBar-foreground);
                    width: 24px;
                    height: 24px;
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
                    margin-bottom: 16px;
                    border-radius: 8px;
                }
                .file-progress {
                    margin-top: 16px;
                    overflow: hidden;
                    max-height: 0;
                    transition: max-height 0.3s ease;
                }
                .file-progress.visible {
                    max-height: 1000px;
                }
                .file-progress-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 12px;
                    font-size: 13px;
                }
                .file-progress-table th,
                .file-progress-table td {
                    padding: 10px;
                    text-align: left;
                    border-bottom: 1px solid var(--vscode-widget-border);
                }
                .file-progress-table th {
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                }
                .file-progress-table tr:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .file-progress-bar {
                    height: 6px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 3px;
                    overflow: hidden;
                    width: 100%;
                }
                .file-progress-fill {
                    height: 100%;
                    background-color: var(--vscode-progressBar-foreground);
                    border-radius: 3px;
                }
                .empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 48px 24px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                }
                .empty-state-icon {
                    font-size: 48px;
                    margin-bottom: 16px;
                    opacity: 0.5;
                }
                .empty-state-title {
                    font-size: 18px;
                    font-weight: 600;
                    margin-bottom: 8px;
                    color: var(--vscode-foreground);
                }
                .empty-state-description {
                    max-width: 400px;
                    margin-bottom: 24px;
                }
                .pagination {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    margin-top: 24px;
                    gap: 16px;
                }
                .page-info {
                    color: var(--vscode-descriptionForeground);
                }
                .action-menu {
                    position: relative;
                    display: inline-block;
                }
                .action-button {
                    background: none;
                    border: none;
                    cursor: pointer;
                    padding: 4px;
                    border-radius: 4px;
                    color: var(--vscode-foreground);
                }
                .action-button:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .actions-dropdown {
                    position: absolute;
                    right: 0;
                    top: 100%;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 4px;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                    min-width: 180px;
                    z-index: 10;
                    display: none;
                }
                .actions-dropdown.visible {
                    display: block;
                }
                .action-item {
                    padding: 8px 12px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .action-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .tab-container {
                    margin-top: 16px;
                }
                .tabs {
                    display: flex;
                    border-bottom: 1px solid var(--vscode-widget-border);
                    margin-bottom: 16px;
                }
                .tab {
                    padding: 8px 16px;
                    cursor: pointer;
                    border-bottom: 2px solid transparent;
                    font-weight: 500;
                }
                .tab.active {
                    border-bottom-color: var(--vscode-textLink-activeForeground);
                    color: var(--vscode-textLink-activeForeground);
                }
                .tab-content {
                    display: none;
                }
                .tab-content.active {
                    display: block;
                }
                .highlight {
                    color: var(--vscode-textLink-activeForeground);
                    font-weight: 600;
                }
            </style>
        </head>
        <body>
            <div class="dashboard">
                <div class="toolbar">
                    <button id="refreshBtn">
                        <span class="icon">↻</span>
                        Refresh
                    </button>
                    <button id="exportBtn" class="secondary">
                        <span class="icon">↓</span>
                        Export Data
                    </button>
                </div>
                
                <div id="errorContainer" class="error" style="display: none;"></div>
                
                <div id="loadingIndicator" class="loading">
                    <div class="loading-spinner"></div>
                    <div>Loading translation progress data...</div>
                </div>
                
                <div id="dashboardContent" style="display: none;">
                    <div class="card">
                        <div class="card-title">Overall Progress</div>
                        <div class="metric-grid">
                            <div class="metric">
                                <div class="metric-value" id="totalProjects">0</div>
                                <div class="metric-label">Active Projects</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value" id="overallCompletion">0%</div>
                                <div class="metric-label">Overall Completion</div>
                            </div>
                            <div class="metric">
                                <div class="metric-value" id="editsLast24h">0</div>
                                <div class="metric-label">Edits in last 24 hours</div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="card">
                        <div class="header">
                            <div class="card-title">Projects</div>
                            <div class="toolbar">
                                <select id="sortProjects" class="secondary">
                                    <option value="lastActivity">Sort by Last Activity</option>
                                    <option value="completion">Sort by Completion</option>
                                    <option value="name">Sort by Name</option>
                                </select>
                            </div>
                        </div>
                        <div id="projectList" class="project-list">
                            <!-- Projects will be added here dynamically -->
                        </div>
                        <div id="emptyProjectsState" class="empty-state" style="display: none;">
                            <div class="empty-state-icon">📋</div>
                            <div class="empty-state-title">No translation projects found</div>
                            <div class="empty-state-description">
                                Create a new translation project to start tracking your progress.
                            </div>
                            <button id="createProjectBtn" class="secondary">
                                Create New Project
                            </button>
                        </div>
                        <div class="pagination">
                            <button id="prevPage" class="secondary">Previous</button>
                            <span id="pageInfo" class="page-info">Page 1</span>
                            <button id="nextPage" class="secondary">Next</button>
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
                    const emptyProjectsState = document.getElementById('emptyProjectsState');
                    const createProjectBtn = document.getElementById('createProjectBtn');
                    const sortProjects = document.getElementById('sortProjects');
                    
                    // Elements for metric display
                    const totalProjects = document.getElementById('totalProjects');
                    const overallCompletion = document.getElementById('overallCompletion');
                    const editsLast24h = document.getElementById('editsLast24h');
                    const projectList = document.getElementById('projectList');
                    
                    // Pagination controls
                    const prevPage = document.getElementById('prevPage');
                    const nextPage = document.getElementById('nextPage');
                    const pageInfo = document.getElementById('pageInfo');
                    
                    // Pagination state
                    let currentPage = 1;
                    const pageSize = 5;
                    let totalPages = 1;
                    
                    // Project data
                    let allProjects = [];
                    
                    // Setup event listeners
                    refreshBtn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'refresh' });
                    });
                    
                    exportBtn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'exportData' });
                    });
                    
                    createProjectBtn.addEventListener('click', () => {
                        vscode.postMessage({ command: 'createProject' });
                    });
                    
                    sortProjects.addEventListener('change', () => {
                        sortProjectList(sortProjects.value);
                        renderProjects();
                    });
                    
                    prevPage.addEventListener('click', () => {
                        if (currentPage > 1) {
                            currentPage--;
                            renderProjects();
                        }
                    });
                    
                    nextPage.addEventListener('click', () => {
                        if (currentPage < totalPages) {
                            currentPage++;
                            renderProjects();
                        }
                    });
                    
                    // Format date for display
                    function formatDate(dateString) {
                        const date = new Date(dateString);
                        const now = new Date();
                        const diffMs = now - date;
                        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                        
                        if (diffDays === 0) {
                            return 'Today, ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        } else if (diffDays === 1) {
                            return 'Yesterday, ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        } else if (diffDays < 7) {
                            return diffDays + ' days ago';
                        } else {
                            return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
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
                    
                    // Estimate project trend (mock for now)
                    function getProjectTrend(project) {
                        // Instead of random values, derive from project ID to keep it consistent
                        // In the future this should be calculated from actual trend data
                        if (!project.projectId) return null;
                        
                        // Use the sum of character codes to generate a deterministic value
                        let sum = 0;
                        for (let i = 0; i < project.projectId.length; i++) {
                            sum += project.projectId.charCodeAt(i);
                        }
                        
                        // Normalize to a value between -1 and 1
                        const normalizedValue = (sum % 100) / 100;
                        
                        // Only show trend if there's progress
                        if (project.completionPercentage > 0) {
                            if (normalizedValue > 0.5) {
                                return { 
                                    direction: 'up', 
                                    value: '+' + (Math.abs(normalizedValue) * 2).toFixed(1) + '%' 
                                };
                            } else {
                                return { 
                                    direction: 'down', 
                                    value: '-' + (Math.abs(normalizedValue) * 2).toFixed(1) + '%' 
                                };
                            }
                        }
                        
                        return null;
                    }
                    
                    // Sort projects based on selected criteria
                    function sortProjectList(criteria) {
                        switch(criteria) {
                            case 'completion':
                                allProjects.sort((a, b) => b.completionPercentage - a.completionPercentage);
                                break;
                            case 'name':
                                allProjects.sort((a, b) => getDisplayName(a).localeCompare(getDisplayName(b)));
                                break;
                            case 'lastActivity':
                            default:
                                allProjects.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
                                break;
                        }
                    }
                    
                    // Render pagination
                    function updatePagination() {
                        totalPages = Math.ceil(allProjects.length / pageSize);
                        pageInfo.textContent = \`Page \${currentPage} of \${totalPages}\`;
                        
                        prevPage.disabled = currentPage === 1;
                        nextPage.disabled = currentPage === totalPages || totalPages === 0;
                        
                        // Update button styles based on state
                        if (prevPage.disabled) {
                            prevPage.style.opacity = '0.5';
                            prevPage.style.cursor = 'not-allowed';
                        } else {
                            prevPage.style.opacity = '1';
                            prevPage.style.cursor = 'pointer';
                        }
                        
                        if (nextPage.disabled) {
                            nextPage.style.opacity = '0.5';
                            nextPage.style.cursor = 'not-allowed';
                        } else {
                            nextPage.style.opacity = '1';
                            nextPage.style.cursor = 'pointer';
                        }
                    }
                    
                    // Render project list with pagination
                    function renderProjects() {
                        projectList.innerHTML = '';
                        
                        if (allProjects.length === 0) {
                            emptyProjectsState.style.display = 'flex';
                            return;
                        }
                        
                        emptyProjectsState.style.display = 'none';
                        
                        // Calculate pagination
                        const startIndex = (currentPage - 1) * pageSize;
                        const endIndex = Math.min(startIndex + pageSize, allProjects.length);
                        const currentPageProjects = allProjects.slice(startIndex, endIndex);
                        
                        // Create project items
                        currentPageProjects.forEach(project => {
                            const projectItem = document.createElement('div');
                            projectItem.className = 'project-item';
                            projectItem.dataset.projectId = project.projectId;
                            
                            const displayName = getDisplayName(project);
                            const lastActivity = formatDate(project.lastActivity);
                            const completionPercentage = Math.round(project.completionPercentage);
                            
                            // Get trend data (mock for now)
                            const trend = getProjectTrend(project);
                            const trendHtml = trend ? 
                                \`<span class="project-trend trend-\${trend.direction}">\${trend.direction === 'up' ? '↑' : '↓'} \${trend.value}</span>\` : '';
                            
                            projectItem.innerHTML = \`
                                <div class="project-info">
                                    <div class="project-name">
                                        \${displayName}
                                        \${trendHtml}
                                    </div>
                                    <div class="project-meta">
                                        <span>Last activity: <span class="highlight">\${lastActivity}</span></span>
                                    </div>
                                    <div class="progress-bar">
                                        <div class="progress-bar-fill" style="width: \${completionPercentage}%"></div>
                                    </div>
                                </div>
                                <div class="project-completion">
                                    \${completionPercentage}%
                                </div>
                            \`;
                            
                            // Add click event to load project details
                            projectItem.addEventListener('click', (e) => {
                                const expandedItems = document.querySelectorAll('.project-item-expanded');
                                expandedItems.forEach(item => {
                                    if (item !== projectItem) {
                                        item.classList.remove('project-item-expanded');
                                        const detailsElement = item.nextElementSibling;
                                        if (detailsElement && detailsElement.classList.contains('file-progress')) {
                                            detailsElement.classList.remove('visible');
                                        }
                                    }
                                });
                                
                                projectItem.classList.toggle('project-item-expanded');
                                
                                // Check if details already exist
                                let detailsElement = projectItem.nextElementSibling;
                                if (detailsElement && detailsElement.classList.contains('file-progress')) {
                                    detailsElement.classList.toggle('visible');
                                } else {
                                    // Create details section
                                    detailsElement = document.createElement('div');
                                    detailsElement.className = 'file-progress visible';
                                    
                                    // Add loading state
                                    detailsElement.innerHTML = \`
                                        <div class="loading" style="height: 100px;">
                                            <div class="loading-spinner"></div>
                                            <div>Loading project details...</div>
                                        </div>
                                    \`;
                                    
                                    // Insert after project item
                                    projectItem.parentNode.insertBefore(detailsElement, projectItem.nextSibling);
                                    
                                    // Get the project ID from the dataset attribute
                                    const clickedProjectId = projectItem.dataset.projectId;
                                    console.log('%c[WEBVIEW] Fetching details for project:', 'background: #2196F3; color: white; padding: 2px 5px; border-radius: 2px;', clickedProjectId);
                                    
                                    // Fetch project details
                                    vscode.postMessage({ 
                                        command: 'fetchProjectDetails', 
                                        projectId: clickedProjectId
                                    });
                                }
                            });
                            
                            projectList.appendChild(projectItem);
                        });
                        
                        updatePagination();
                    }
                    
                    // Update project details when received
                    function updateProjectDetails(projectId, details) {
                        console.log('%c[WEBVIEW] Updating project details:', 'background: #4CAF50; color: white; padding: 2px 5px; border-radius: 2px;', projectId);
                        
                        const projectItem = document.querySelector('.project-item[data-project-id="' + projectId + '"]');
                        if (!projectItem) {
                            console.error('[WEBVIEW] Project item not found:', projectId);
                            return;
                        }
                        
                        const detailsElement = projectItem.nextElementSibling;
                        if (!detailsElement || !detailsElement.classList.contains('file-progress')) {
                            console.error('[WEBVIEW] Details element not found for project:', projectId);
                            return;
                        }
                        
                        // Get file data safely with proper null checks
                        const translationProgress = details.translationProgress || {};
                        const bookCompletionMap = translationProgress.bookCompletionMap || {};
                        const fileList = Object.keys(bookCompletionMap);
                        
                        // Log what we found
                        console.log('[WEBVIEW] Found ' + fileList.length + ' files for project ' + projectId);
                        if (fileList.length > 0) {
                            console.log('[WEBVIEW] First few files:', fileList.slice(0, 5));
                        }
                        
                        // Start building the HTML with tabs
                        let detailsHtml = 
                            '<div class="tab-container">' +
                                '<div class="tabs">' +
                                    '<div class="tab active" data-tab="files">Files (' + fileList.length + ')</div>' +
                                    '<div class="tab" data-tab="metrics">Metrics</div>' +
                                    '<div class="tab" data-tab="activity">Activity</div>' +
                                '</div>' +
                                
                                '<div class="tab-content active" data-tab-content="files">';
                        
                        // Add file completion data if available
                        if (fileList.length > 0) {
                            detailsHtml += 
                                '<table class="file-progress-table">' +
                                    '<thead>' +
                                        '<tr>' +
                                            '<th>File</th>' +
                                            '<th>Completion</th>' +
                                            '<th>Progress</th>' +
                                        '</tr>' +
                                    '</thead>' +
                                    '<tbody>';
                            
                            // Add each file with its completion percentage
                            fileList.forEach(fileName => {
                                // Get completion value and normalize it
                                const completion = bookCompletionMap[fileName];
                                const percentComplete = typeof completion === 'number' ? 
                                    Math.round(completion) : 
                                    (typeof completion === 'string' ? parseInt(completion, 10) : 0);
                                
                                detailsHtml += 
                                    '<tr>' +
                                        '<td>' + fileName + '</td>' +
                                        '<td>' + percentComplete + '%</td>' +
                                        '<td>' +
                                            '<div class="file-progress-bar">' +
                                                '<div class="file-progress-fill" style="width: ' + percentComplete + '%"></div>' +
                                            '</div>' +
                                        '</td>' +
                                    '</tr>';
                            });
                            
                            detailsHtml += 
                                    '</tbody>' +
                                '</table>';
                        } else {
                            // Show empty state if no files
                            detailsHtml += 
                                '<div class="empty-state" style="padding: 24px;">' +
                                    '<div>No file data available for this project</div>' +
                                '</div>';
                        }
                        
                        // Get other metric data with proper null checks
                        const validationStatus = details.validationStatus || {};
                        const activityMetrics = details.activityMetrics || {};
                        const qualityMetrics = details.qualityMetrics || {};
                        
                        // Add metrics tab content
                        detailsHtml += 
                            '</div>' +
                            
                            '<div class="tab-content" data-tab-content="metrics">' +
                                '<table class="file-progress-table">' +
                                    '<tbody>' +
                                        '<tr>' +
                                            '<td><strong>Total verses:</strong></td>' +
                                            '<td>' + (translationProgress.totalVerseCount || 0) + '</td>' +
                                        '</tr>' +
                                        '<tr>' +
                                            '<td><strong>Translated verses:</strong></td>' +
                                            '<td>' + (translationProgress.translatedVerseCount || 0) + '</td>' +
                                        '</tr>' +
                                        '<tr>' +
                                            '<td><strong>Validated verses:</strong></td>' +
                                            '<td>' + (translationProgress.validatedVerseCount || 0) + '</td>' +
                                        '</tr>' +
                                        '<tr>' +
                                            '<td><strong>Words translated:</strong></td>' +
                                            '<td>' + (translationProgress.wordsTranslated || 0) + '</td>' +
                                        '</tr>' +
                                        '<tr>' +
                                            '<td><strong>Quality issues:</strong></td>' +
                                            '<td>' + (qualityMetrics.spellcheckIssueCount || 0) + ' spelling, ' +
                                               (qualityMetrics.flaggedSegmentsCount || 0) + ' flagged segments</td>' +
                                        '</tr>' +
                                    '</tbody>' +
                                '</table>' +
                            '</div>' +
                            
                            '<div class="tab-content" data-tab-content="activity">' +
                                '<table class="file-progress-table">' +
                                    '<tbody>' +
                                        '<tr>' +
                                            '<td><strong>Last edit:</strong></td>' +
                                            '<td>' + formatDate(activityMetrics.lastEditTimestamp || details.timestamp) + '</td>' +
                                        '</tr>' +
                                        '<tr>' +
                                            '<td><strong>Last validation:</strong></td>' +
                                            '<td>' + formatDate(validationStatus.lastValidationTimestamp || details.timestamp) + '</td>' +
                                        '</tr>' +
                                        '<tr>' +
                                            '<td><strong>Edits (last 24h):</strong></td>' +
                                            '<td>' + (activityMetrics.editCountLast24Hours || 0) + '</td>' +
                                        '</tr>' +
                                        '<tr>' +
                                            '<td><strong>Edits (last week):</strong></td>' +
                                            '<td>' + (activityMetrics.editCountLastWeek || 0) + '</td>' +
                                        '</tr>' +
                                        '<tr>' +
                                            '<td><strong>Avg. daily edits:</strong></td>' +
                                            '<td>' + (activityMetrics.averageDailyEdits || 0).toFixed(1) + '</td>' +
                                        '</tr>' +
                                    '</tbody>' +
                                '</table>' +
                            '</div>' +
                        '</div>' +
                        
                        '<div class="toolbar" style="margin-top: 16px; justify-content: flex-end;">' +
                            '<button class="open-project-btn secondary" data-project-id="' + projectId + '">' +
                                'Open Project' +
                            '</button>' +
                        '</div>';
                        
                        // Set the HTML and add event handlers
                        detailsElement.innerHTML = detailsHtml;
                        
                        // Add tab switching logic
                        const tabs = detailsElement.querySelectorAll('.tab');
                        tabs.forEach(tab => {
                            tab.addEventListener('click', () => {
                                // Remove active class from all tabs
                                tabs.forEach(t => t.classList.remove('active'));
                                
                                // Add active class to clicked tab
                                tab.classList.add('active');
                                
                                // Show corresponding content
                                const tabContents = detailsElement.querySelectorAll('.tab-content');
                                tabContents.forEach(content => {
                                    content.classList.remove('active');
                                    if (content.dataset.tabContent === tab.dataset.tab) {
                                        content.classList.add('active');
                                    }
                                });
                            });
                        });
                        
                        // Add open project handler
                        const openBtn = detailsElement.querySelector('.open-project-btn');
                        if (openBtn) {
                            openBtn.addEventListener('click', function(e) {
                                e.stopPropagation();
                                vscode.postMessage({
                                    command: 'openProject',
                                    projectId: this.getAttribute('data-project-id')
                                });
                            });
                        }
                    }
                    
                    // Calculate total edits in the last 24 hours
                    function calculateTotalEdits(projects) {
                        return projects.reduce((sum, project) => {
                            return sum + (project.editCountLast24Hours || 0);
                        }, 0);
                    }
                    
                    // Handle messages from the extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        console.log('Received message:', message);
                        
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
                                dashboardContent.style.display = 'flex';
                                dashboardContent.style.flexDirection = 'column';
                                dashboardContent.style.gap = '1rem';
                                errorContainer.style.display = 'none';
                                
                                // Update metrics
                                const aggregateData = message.aggregateData;
                                if (aggregateData) {
                                    totalProjects.textContent = aggregateData.projectCount || '0';
                                    overallCompletion.textContent = \`\${Math.round(aggregateData.totalCompletionPercentage || 0)}%\`;
                                    
                                    // Store project data for pagination
                                    if (aggregateData.projectSummaries && aggregateData.projectSummaries.length) {
                                        allProjects = aggregateData.projectSummaries;
                                        
                                        // Sort by the selected criteria
                                        sortProjectList(sortProjects.value);
                                        
                                        // Try to calculate total edits
                                        const recentReports = message.recentReports?.reports || [];
                                        editsLast24h.textContent = calculateTotalEdits(recentReports).toString();
                                        
                                        // Start at page 1
                                        currentPage = 1;
                                        renderProjects();
                                    } else {
                                        allProjects = [];
                                        renderProjects();
                                    }
                                }
                                break;
                                
                            case 'updateProjectDetails':
                                if (message.projectId && message.details) {
                                    console.log('%c[WEBVIEW] Received project details from server:', 'background: #4CAF50; color: white; padding: 2px 5px; border-radius: 2px;', message.projectId);
                                    console.log('%c[WEBVIEW] Full details object:', 'background: #4CAF50; color: white; padding: 2px 5px; border-radius: 2px;', message.details);
                                    
                                    updateProjectDetails(message.projectId, message.details);
                                } else {
                                    console.error('%c[WEBVIEW] Invalid project details received', 'background: #F44336; color: white; padding: 2px 5px; border-radius: 2px;', message);
                                }
                                break;
                            
                            case 'updateProjectDetailsStatus':
                                if (message.projectId && message.status) {
                                    console.log('Project details status update:', message.projectId, message.status);
                                    const projectItemSelector = '.project-item[data-project-id="' + message.projectId + '"]';
                                    const projectItem = document.querySelector(projectItemSelector);
                                    if (!projectItem) {
                                        console.error('Project item not found with selector:', projectItemSelector);
                                        return;
                                    }
                                    
                                    const detailsElement = projectItem.nextElementSibling;
                                    if (!detailsElement || !detailsElement.classList.contains('file-progress')) {
                                        console.error('Details element not found for project:', message.projectId);
                                        return;
                                    }
                                    
                                    if (message.status === 'error') {
                                        detailsElement.innerHTML = 
                                            '<div class="error" style="margin: 16px;">' +
                                                (message.message || 'Failed to load project details') +
                                            '</div>' +
                                            '<div class="toolbar" style="margin: 16px; justify-content: flex-end;">' +
                                                '<button class="refresh-details-btn secondary" data-project-id="' + message.projectId + '">' +
                                                    '<span class="icon">↻</span> Retry' +
                                                '</button>' +
                                            '</div>';
                                        
                                        // Add retry handler
                                        const retryBtn = detailsElement.querySelector('.refresh-details-btn');
                                        if (retryBtn) {
                                            retryBtn.addEventListener('click', function(e) {
                                                e.stopPropagation();
                                                const btnProjectId = this.getAttribute('data-project-id');
                                                vscode.postMessage({ 
                                                    command: 'fetchProjectDetails', 
                                                    projectId: btnProjectId 
                                                });
                                            });
                                        }
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

    // Add method to fetch detailed project reports with proper typing
    private async _fetchProjectDetails(projectId: string) {
        try {
            console.log(
                `%c[PROGRESS DASHBOARD] Fetching project details for ${projectId}`,
                "background: #2196F3; color: white; padding: 2px 5px; border-radius: 2px;"
            );

            // Send loading status to specific project details section instead of global status
            this._panel.webview.postMessage({
                type: "updateProjectDetailsStatus",
                projectId: projectId,
                status: "loading",
            });

            // Fix parameter name: use projectIds as an array instead of projectId
            const detailed = (await vscode.commands.executeCommand("frontier.getProgressReports", {
                projectIds: [projectId], // Correct parameter name
                limit: 1,
            })) as { reports: ProjectProgressReport[]; totalCount: number };

            console.log(
                "%c[PROGRESS DASHBOARD] Received project details:",
                "background: #4CAF50; color: white; padding: 2px 5px; border-radius: 2px;",
                detailed
            );

            if (detailed && detailed.reports && detailed.reports.length > 0) {
                // Send the details back to the webview
                this._panel.webview.postMessage({
                    type: "updateProjectDetails",
                    projectId: projectId,
                    details: detailed.reports[0],
                });
            } else {
                // Send error back to the specific project section
                this._panel.webview.postMessage({
                    type: "updateProjectDetailsStatus",
                    projectId: projectId,
                    status: "error",
                    message: "No data found for this project",
                });
                console.error(
                    "[PROGRESS DASHBOARD] No detailed report found for project:",
                    projectId,
                    "API response:",
                    detailed
                );
            }
        } catch (error) {
            console.error("[PROGRESS DASHBOARD] Error fetching project details:", error);

            // Send error back to the specific project section
            this._panel.webview.postMessage({
                type: "updateProjectDetailsStatus",
                projectId: projectId,
                status: "error",
                message: `Failed to load project details: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
}
