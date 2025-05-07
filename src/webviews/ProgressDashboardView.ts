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

            // Get project details - most recent report for this project
            const detailed = (await vscode.commands.executeCommand("frontier.getProgressReports", {
                projectIds: [projectId],
                limit: 1,
            })) as { reports: ProjectProgressReport[]; totalCount: number };

            if (detailed && detailed.reports && detailed.reports.length > 0) {
                // Store in cache
                this._projectDetailsCache.set(projectId, detailed.reports[0]);

                // Send the details back to the webview
                this._panel.webview.postMessage({
                    type: "updateProjectDetails",
                    projectId: projectId,
                    details: detailed.reports[0],
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
     * Get the HTML for the webview - simplified clean table-based design
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
                    gap: 20px;
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
                    margin: 0;
                }
                .summary-card {
                    background-color: var(--vscode-widget-shadow);
                    border-radius: 6px;
                    padding: 20px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
                }
                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 15px;
                    margin-top: 10px;
                }
                .stat-item {
                    background-color: var(--vscode-editor-background);
                    padding: 12px;
                    border-radius: 6px;
                    border: 1px solid var(--vscode-widget-border);
                    text-align: center;
                }
                .stat-value {
                    font-size: 24px;
                    font-weight: 700;
                    color: var(--vscode-textLink-activeForeground);
                }
                .stat-label {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 4px;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 10px;
                    font-size: 14px;
                }
                th {
                    text-align: left;
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-widget-border);
                    background-color: var(--vscode-widget-shadow);
                    font-weight: 600;
                }
                td {
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-widget-border);
                }
                tr:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .progress-bar {
                    height: 8px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 4px;
                    overflow: hidden;
                    width: 100%;
                }
                .progress-fill {
                    height: 100%;
                    background-color: var(--vscode-progressBar-foreground);
                    border-radius: 4px;
                }
                .toolbar {
                    display: flex;
                    gap: 10px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
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
                .loading {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 40px;
                    color: var(--vscode-descriptionForeground);
                }
                .loading-spinner {
                    border: 3px solid rgba(0, 0, 0, 0.1);
                    border-radius: 50%;
                    border-top: 3px solid var(--vscode-progressBar-foreground);
                    width: 24px;
                    height: 24px;
                    animation: spin 1s linear infinite;
                    margin-bottom: 10px;
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
                    border-radius: 6px;
                }
                .empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    padding: 40px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                }
                .project-details {
                    margin-top: 15px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 6px;
                    padding: 15px;
                    display: none;
                }
                .project-details.visible {
                    display: block;
                }
                .book-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
                    gap: 10px;
                    margin-top: 15px;
                }
                .book-item {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 4px;
                    padding: 8px;
                    font-size: 12px;
                }
                .book-name {
                    font-weight: 600;
                    margin-bottom: 4px;
                }
                .book-progress {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                }
                .highlight {
                    color: var(--vscode-textLink-activeForeground);
                    font-weight: 600;
                }
                .actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 10px;
                    margin-top: 15px;
                }
            </style>
        </head>
        <body>
            <div class="dashboard">
                <div class="header">
                    <h1 class="title">Translation Progress Dashboard</h1>
                    <div class="toolbar">
                        <button id="refreshBtn">
                            <span>↻</span> Refresh
                        </button>
                        <button id="exportBtn" class="secondary">
                            <span>↓</span> Export
                        </button>
                    </div>
                </div>
                
                <div id="errorContainer" class="error" style="display: none;"></div>
                
                <div id="loadingIndicator" class="loading">
                    <div class="loading-spinner"></div>
                    <div>Loading translation progress data...</div>
                </div>
                
                <div id="dashboardContent" style="display: none;">
                    <div class="summary-card">
                        <h2>Overall Progress</h2>
                        <div class="stats-grid">
                            <div class="stat-item">
                                <div class="stat-value" id="totalProjects">0</div>
                                <div class="stat-label">Active Projects</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-value" id="overallCompletion">0%</div>
                                <div class="stat-label">Average Completion</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-value" id="totalVerses">0</div>
                                <div class="stat-label">Total Verses</div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-value" id="translatedVerses">0</div>
                                <div class="stat-label">Translated Verses</div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="summary-card">
                        <h2>Projects</h2>
                        <table id="projectsTable">
                            <thead>
                                <tr>
                                    <th>Project</th>
                                    <th>Last Activity</th>
                                    <th>Completion</th>
                                    <th>Progress</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody id="projectsTableBody">
                                <!-- Project rows will be added here -->
                            </tbody>
                        </table>
                        
                        <div id="emptyProjectsState" class="empty-state" style="display: none;">
                            <div>No translation projects found</div>
                            <button id="createProjectBtn" class="secondary" style="margin-top: 15px;">
                                Create New Project
                            </button>
                        </div>
                    </div>
                    
                    <div id="projectDetails" class="project-details">
                        <h3 id="projectDetailsTitle">Project Details</h3>
                        <div id="projectDetailsContent">
                            <!-- Project details will be added here -->
                        </div>
                    </div>
                </div>
            </div>
            
            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    
                    // Initialize project tracking
                    window.projectDetailsMap = new Map();
                    window.expandedProjects = new Set();
                    
                    // DOM elements
                    const refreshBtn = document.getElementById('refreshBtn');
                    const exportBtn = document.getElementById('exportBtn');
                    const errorContainer = document.getElementById('errorContainer');
                    const loadingIndicator = document.getElementById('loadingIndicator');
                    const dashboardContent = document.getElementById('dashboardContent');
                    const emptyProjectsState = document.getElementById('emptyProjectsState');
                    const createProjectBtn = document.getElementById('createProjectBtn');
                    const projectsTableBody = document.getElementById('projectsTableBody');
                    const projectDetails = document.getElementById('projectDetails');
                    const projectDetailsTitle = document.getElementById('projectDetailsTitle');
                    const projectDetailsContent = document.getElementById('projectDetailsContent');
                    
                    // Elements for metric display
                    const totalProjects = document.getElementById('totalProjects');
                    const overallCompletion = document.getElementById('overallCompletion');
                    const totalVerses = document.getElementById('totalVerses');
                    const translatedVerses = document.getElementById('translatedVerses');
                    
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
                    
                    // Format date for better display
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
                    
                    // Render projects as table rows
                    function renderProjects(projects) {
                        projectsTableBody.innerHTML = '';
                        
                        if (!projects || projects.length === 0) {
                            emptyProjectsState.style.display = 'flex';
                            return;
                        }
                        
                        emptyProjectsState.style.display = 'none';
                        
                        projects.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
                        
                        projects.forEach(project => {
                            const row = document.createElement('tr');
                            row.dataset.projectId = project.projectId;
                            
                            const displayName = getDisplayName(project);
                            const lastActivity = formatDate(project.lastActivity);
                            const completionPercentage = project.completionPercentage.toFixed(2);
                            
                            row.innerHTML = \`
                                <td>\${displayName}</td>
                                <td>\${lastActivity}</td>
                                <td>\${completionPercentage}%</td>
                                <td>
                                    <div class="progress-bar">
                                        <div class="progress-fill" style="width: \${completionPercentage}%"></div>
                                    </div>
                                </td>
                                <td>
                                    <button class="details-btn secondary" data-project-id="\${project.projectId}">Details</button>
                                </td>
                            \`;
                            
                            projectsTableBody.appendChild(row);
                        });
                        
                        // Add event listeners to the details buttons
                        document.querySelectorAll('.details-btn').forEach(btn => {
                            btn.addEventListener('click', (e) => {
                                const projectId = e.target.dataset.projectId;
                                showProjectDetails(projectId);
                            });
                        });
                    }
                    
                    // Show project details
                    function showProjectDetails(projectId) {
                        // Check if we have the data cached
                        if (window.projectDetailsMap.has(projectId)) {
                            displayProjectDetails(projectId, window.projectDetailsMap.get(projectId));
                            return;
                        }
                        
                        // Show loading state
                        projectDetails.classList.add('visible');
                        projectDetailsTitle.textContent = 'Loading project details...';
                        projectDetailsContent.innerHTML = \`
                            <div class="loading" style="height: 80px;">
                                <div class="loading-spinner"></div>
                                <div>Loading details...</div>
                            </div>
                        \`;
                        
                        // Fetch project details
                        vscode.postMessage({ 
                            command: 'fetchProjectDetails', 
                            projectId: projectId
                        });
                    }
                    
                    // Display project details in the UI
                    function displayProjectDetails(projectId, details) {
                        projectDetails.classList.add('visible');
                        
                        // Get project name
                        const projectRow = document.querySelector(\`tr[data-project-id="\${projectId}"]\`);
                        const projectName = projectRow ? projectRow.cells[0].textContent : 'Project Details';
                        
                        projectDetailsTitle.textContent = projectName;
                        
                        // Extract data safely
                        const translationProgress = details.translationProgress || {};
                        const bookCompletionMap = translationProgress.bookCompletionMap || {};
                        const books = Object.keys(bookCompletionMap);
                        
                        // Build the content HTML
                        let detailsHtml = \`
                            <div class="stats-grid" style="margin-bottom: 15px;">
                                <div class="stat-item">
                                    <div class="stat-value">\${translationProgress.totalVerseCount || 0}</div>
                                    <div class="stat-label">Total Verses</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value">\${translationProgress.translatedVerseCount || 0}</div>
                                    <div class="stat-label">Translated</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value">\${translationProgress.validatedVerseCount || 0}</div>
                                    <div class="stat-label">Validated</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-value">\${translationProgress.wordsTranslated || 0}</div>
                                    <div class="stat-label">Words</div>
                                </div>
                            </div>
                        \`;
                        
                        // Add book completion grid if books exist
                        if (books.length > 0) {
                            detailsHtml += '<h4>Book Completion</h4><div class="book-grid">';
                            
                            books.forEach(book => {
                                const completion = bookCompletionMap[book];
                                detailsHtml += \`
                                    <div class="book-item">
                                        <div class="book-name">\${book}</div>
                                        <div class="book-progress">\${completion.toFixed(2)}%</div>
                                        <div class="progress-bar">
                                            <div class="progress-fill" style="width: \${completion}%"></div>
                                        </div>
                                    </div>
                                \`;
                            });
                            
                            detailsHtml += '</div>';
                        }
                        
                        // Add close button
                        detailsHtml += \`
                            <div class="actions">
                                <button id="closeDetailsBtn" class="secondary">Close</button>
                            </div>
                        \`;
                        
                        projectDetailsContent.innerHTML = detailsHtml;
                        
                        // Add event listener to close button
                        document.getElementById('closeDetailsBtn').addEventListener('click', () => {
                            projectDetails.classList.remove('visible');
                        });
                    }
                    
                    // Calculate aggregate metrics
                    function updateAggregateMetrics(aggregateData) {
                        if (!aggregateData) return;
                        
                        let totalVerseCount = 0;
                        let translatedVerseCount = 0;
                        
                        // Try to aggregate data from project summaries
                        if (aggregateData.projectSummaries && aggregateData.projectSummaries.length > 0) {
                            totalProjects.textContent = aggregateData.projectCount || aggregateData.projectSummaries.length;
                            overallCompletion.textContent = aggregateData.totalCompletionPercentage.toFixed(2) + '%';
                            
                            // We can only show these metrics if they're available
                            if (window.projectDetailsMap.size > 0) {
                                for (const details of window.projectDetailsMap.values()) {
                                    const progress = details.translationProgress || {};
                                    totalVerseCount += progress.totalVerseCount || 0;
                                    translatedVerseCount += progress.translatedVerseCount || 0;
                                }
                                
                                totalVerses.textContent = totalVerseCount;
                                translatedVerses.textContent = translatedVerseCount;
                            }
                        }
                    }
                    
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
                                
                                // Update UI
                                const aggregateData = message.aggregateData;
                                if (aggregateData && aggregateData.projectSummaries) {
                                    renderProjects(aggregateData.projectSummaries);
                                    updateAggregateMetrics(aggregateData);
                                }
                                break;
                                
                            case 'updateProjectDetails':
                                if (message.projectId && message.details) {
                                    // Cache the project details
                                    window.projectDetailsMap.set(message.projectId, message.details);
                                    
                                    // Display the details
                                    displayProjectDetails(message.projectId, message.details);
                                    
                                    // Update aggregate metrics since we have new data
                                    updateAggregateMetrics(message.aggregateData);
                                }
                                break;
                                
                            case 'updateProjectDetailsStatus':
                                if (message.status === 'error') {
                                    projectDetails.classList.add('visible');
                                    projectDetailsTitle.textContent = 'Error Loading Details';
                                    projectDetailsContent.innerHTML = \`
                                        <div class="error">\${message.message || 'Failed to load project details'}</div>
                                        <div class="actions">
                                            <button id="closeDetailsBtn" class="secondary">Close</button>
                                        </div>
                                    \`;
                                    
                                    document.getElementById('closeDetailsBtn').addEventListener('click', () => {
                                        projectDetails.classList.remove('visible');
                                    });
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
