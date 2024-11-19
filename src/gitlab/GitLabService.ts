import * as vscode from 'vscode';
import { FrontierAuthProvider } from '../auth/AuthenticationProvider';

interface GitLabUser {
    id: number;
    username: string;
    name: string;
    email: string;
}

export interface GitLabProjectOptions {
    name: string;
    description?: string;
    visibility?: 'private' | 'internal' | 'public';
    organizationId?: string;
}

interface GitLabGroup {
    id: number;
    name: string;
    path: string;
    full_path: string;
    parent_id: number | null;
    visibility: 'private' | 'internal' | 'public';
}

export class GitLabService {
    private gitlabToken: string | undefined;
    private gitlabBaseUrl: string | undefined;

    constructor(
        private authProvider: FrontierAuthProvider,
    ) {}

    async initialize(): Promise<void> {
        const sessions = await this.authProvider.getSessions();
        const session = sessions[0];
        if (!session) {
            throw new Error('No active session');
        }
        this.gitlabToken = (session as any).gitlabToken;
        this.gitlabBaseUrl = (session as any).gitlabUrl;

        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            throw new Error('GitLab credentials not found in session');
        }
    }

    async getCurrentUser(): Promise<GitLabUser> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            throw new Error('GitLab not initialized');
        }

        const response = await fetch(`${this.gitlabBaseUrl}/api/v4/user`, {
            headers: {
                'Authorization': `Bearer ${this.gitlabToken}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to get user info: ${response.statusText}`);
        }

        const user = await response.json() as GitLabUser;
        return user;
    }

    async getProject(name: string, organizationId?: string): Promise<{ id: number; url: string } | null> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initialize();
        }

        try {
            let endpoint: string;
            if (organizationId) {
                endpoint = `${this.gitlabBaseUrl}/api/v4/groups/${organizationId}/projects?search=${encodeURIComponent(name)}`;
            } else {
                endpoint = `${this.gitlabBaseUrl}/api/v4/users/${(await this.getCurrentUser()).id}/projects?search=${encodeURIComponent(name)}`;
            }

            const response = await fetch(endpoint, {
                headers: {
                    'Authorization': `Bearer ${this.gitlabToken}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to get project: ${response.statusText}`);
            }

            const projects = await response.json();
            const project = projects.find((p: any) => p.name.toLowerCase() === name.toLowerCase());
            
            return project ? {
                id: project.id,
                url: project.http_url_to_repo,
            } : null;
        } catch (error) {
            console.error('Error getting project:', error);
            return null;
        }
    }

    async createProject(options: GitLabProjectOptions): Promise<{ id: number; url: string }> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initialize();
        }

        try {
            // First check if project already exists
            const existingProject = await this.getProject(options.name, options.organizationId);
            if (existingProject) {
                return existingProject;
            }

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
                    initialize_with_readme: true,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || response.statusText);
            }

            const project = await response.json();
            return {
                id: project.id,
                url: project.http_url_to_repo,
            };
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Failed to create project: ${error.message}`);
            }
            throw error;
        }
    }

    async listOrganizations(): Promise<Array<{ id: string; name: string; path: string }>> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initialize();
        }

        try {
            const params = new URLSearchParams({
                min_access_level: '20',
                owned: 'true'
            }).toString();
            
            const response = await fetch(`${this.gitlabBaseUrl}/api/v4/groups?${params}`, {
                headers: {
                    'Authorization': `Bearer ${this.gitlabToken}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to list organizations: ${response.statusText}`);
            }

            const groups = await response.json();
            return groups.map((group: any) => ({
                id: group.id.toString(),
                name: group.name,
                path: group.path
            }));
        } catch (error) {
            console.error('Failed to list organizations:', error);
            return [];
        }
    }

    getToken(): string | undefined {
        return this.gitlabToken;
    }

    getBaseUrl(): string | undefined {
        return this.gitlabBaseUrl;
    }
}