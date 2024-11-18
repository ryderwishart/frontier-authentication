import * as vscode from 'vscode';
import { FrontierAuthProvider } from '../auth/AuthenticationProvider';

export interface GitLabProjectOptions {
    name: string;
    description?: string;
    visibility?: 'private' | 'internal' | 'public';
    organizationId?: string;
}

export class GitLabService {
    private gitlabBaseUrl: string;
    private gitlabToken: string | undefined;

    constructor(
        private authProvider: FrontierAuthProvider,
    ) {
        this.gitlabBaseUrl = ''; // Will be set during initialization
    }
    async initialize(): Promise<void> {
        const sessions = await this.authProvider.getSessions();
        const session = sessions[0];
        if (!session) {
            throw new Error('No active session');
        }
        this.gitlabToken = (session as any).gitlabToken;
        this.gitlabBaseUrl = (session as any).gitlabUrl;

        console.log('GitLab service initialized with token:', this.gitlabToken, 'and base URL:', this.gitlabBaseUrl);
    }

    async createProject(options: GitLabProjectOptions): Promise<{ id: number; url: string }> {
        if (!this.gitlabToken) {
            throw new Error('GitLab token not available');
        }

        try {
            const endpoint = options.organizationId
                ? `${this.gitlabBaseUrl}/api/v4/groups/${options.organizationId}/projects`
                : `${this.gitlabBaseUrl}/api/v4/projects`;

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.gitlabToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: options.name,
                    description: options.description,
                    visibility: options.visibility || 'private',
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(`Failed to create project: ${error.message || response.statusText}`);
            }

            const project = await response.json();
            return {
                id: project.id,
                url: project.http_url_to_repo,
            };
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('401')) {
                    throw new Error('GitLab authentication failed. Please check your credentials.');
                }
                if (error.message.includes('403')) {
                    throw new Error('You don\'t have permission to create projects in this organization.');
                }
            }
            throw error;
        }
    }

    async listOrganizations(): Promise<Array<{ id: string; name: string }>> {
        if (!this.gitlabToken) {
            throw new Error('GitLab token not available');
        }

        try {
            const response = await fetch(`${this.gitlabBaseUrl}/api/v4/groups`, {
                headers: {
                    'Authorization': `Bearer ${this.gitlabToken}`,
                },
            });

            if (!response.ok) {
                throw new Error('Failed to fetch organizations');
            }

            const groups = await response.json();
            return groups.map((group: any) => ({
                id: group.id,
                name: group.name,
            }));
        } catch (error) {
            console.error('Failed to list organizations:', error);
            throw error;
        }
    }
} 