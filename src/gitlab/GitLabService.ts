import * as vscode from "vscode";
import { FrontierAuthProvider } from "../auth/AuthenticationProvider";

interface GitLabUser {
    id: number;
    username: string;
    name: string;
    email: string;
    group?: string;
}

export interface GitLabProjectOptions {
    name: string;
    description?: string;
    visibility?: "private" | "internal" | "public";
    groupId?: string;
}

interface GitLabGroup {
    id: number;
    name: string;
    path: string;
    full_path: string;
    parent_id: number | null;
    visibility: "private" | "internal" | "public";
}

interface GitLabProject {
    id: number;
    name: string;
    description: string | null;
    visibility: "private" | "internal" | "public";
    http_url_to_repo: string;
    web_url: string;
    created_at: string;
    last_activity_at: string;
    owner: {
        id: number;
        name: string;
        username: string;
    } | null;
    namespace: {
        id: number;
        name: string;
        path: string;
        kind: string;
        full_path: string;
    };
}

export class GitLabService {
    private gitlabToken: string | undefined;
    private gitlabBaseUrl: string | undefined;

    constructor(private authProvider: FrontierAuthProvider) {}

    async initialize(): Promise<void> {
        const sessions = await this.authProvider.getSessions();
        const session = sessions[0];
        if (!session) {
            throw new Error("No active session");
        }
        this.gitlabToken = (session as any).gitlabToken;
        this.gitlabBaseUrl = (session as any).gitlabUrl;

        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            throw new Error("GitLab credentials not found in session");
        }
    }

    async getCurrentUser(): Promise<GitLabUser> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            throw new Error("GitLab not initialized");
        }

        const response = await fetch(`${this.gitlabBaseUrl}/api/v4/user`, {
            headers: {
                Authorization: `Bearer ${this.gitlabToken}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to get user info: ${response.statusText}`);
        }

        const user = (await response.json()) as GitLabUser;
        // console.log("USER IN GITLAB", JSON.stringify(user, null, 2));
        return user;
    }

    async getProject(name: string, groupId?: string): Promise<{ id: number; url: string } | null> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initialize();
        }

        try {
            let endpoint: string;
            if (groupId) {
                endpoint = `${this.gitlabBaseUrl}/api/v4/groups/${groupId}/projects?search=${encodeURIComponent(name)}`;
            } else {
                endpoint = `${this.gitlabBaseUrl}/api/v4/users/${(await this.getCurrentUser()).id}/projects?search=${encodeURIComponent(name)}`;
            }

            const response = await fetch(endpoint, {
                headers: {
                    Authorization: `Bearer ${this.gitlabToken}`,
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to get project: ${response.statusText}`);
            }

            const projects = await response.json();
            const project = projects.find((p: any) => p.name.toLowerCase() === name.toLowerCase());

            return project
                ? {
                      id: project.id,
                      url: project.http_url_to_repo,
                  }
                : null;
        } catch (error) {
            console.error("Error getting project:", error);
            return null;
        }
    }

    async createProject(options: GitLabProjectOptions): Promise<{ id: number; url: string }> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initialize();
        }

        try {
            // First check if project already exists
            const existingProject = await this.getProject(options.name, options.groupId);
            if (existingProject) {
                return existingProject;
            }

            const name =
                options.name.replace(/ /g, "-").replace(/\./g, "-") || vscode.workspace.name;
            const description = options.description || "";
            const visibility = options.visibility || "private";

            const endpoint = `${this.gitlabBaseUrl}/api/v4/projects`;

            const body: Record<string, any> = {
                name,
                description,
                visibility,
                initialize_with_readme: true, // TODO: use the project metadata to populate a project README?
                default_branch_protection: 0, // NOTE: we have no default branch protection
            };

            if (options.groupId) {
                body.namespace_id = options.groupId;
            }

            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.gitlabToken}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
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

    async listGroups(): Promise<Array<{ id: string; name: string; path: string }>> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initialize();
        }

        try {
            const allGroups: Array<{ id: string; name: string; path: string }> = [];
            let currentPage = 1;
            let hasNextPage = true;

            while (hasNextPage) {
                const params = new URLSearchParams({
                    min_access_level: "20",
                    page: currentPage.toString(),
                    per_page: "100",
                }).toString();

                const response = await fetch(`${this.gitlabBaseUrl}/api/v4/groups?${params}`, {
                    headers: {
                        Authorization: `Bearer ${this.gitlabToken}`,
                        "Content-Type": "application/json",
                    },
                });

                if (!response.ok) {
                    throw new Error(`Failed to list groups: ${response.statusText}`);
                }

                const groups = await response.json();
                allGroups.push(
                    ...groups.map((group: any) => ({
                        id: group.id.toString(),
                        name: group.name,
                        path: group.path,
                    }))
                );

                const nextPage = response.headers.get("X-Next-Page");
                hasNextPage = !!nextPage;
                currentPage++;
            }

            return allGroups;
        } catch (error) {
            console.error("Failed to list groups:", error);
            return [];
        }
    }

    async listProjects(
        options: {
            owned?: boolean;
            membership?: boolean;
            search?: string;
            orderBy?: "id" | "name" | "path" | "created_at" | "updated_at" | "last_activity_at";
            sort?: "asc" | "desc";
        } = {}
    ): Promise<GitLabProject[]> {
        if (!this.gitlabToken || !this.gitlabBaseUrl) {
            await this.initialize();
        }

        try {
            const allProjects: GitLabProject[] = [];
            let currentPage = 1;
            let hasNextPage = true;

            while (hasNextPage) {
                const queryParams = new URLSearchParams({
                    ...(options.owned !== undefined && { owned: options.owned.toString() }),
                    ...(options.membership !== undefined && {
                        membership: options.membership.toString(),
                    }),
                    ...(options.search && { search: options.search }),
                    ...(options.orderBy && { order_by: options.orderBy }),
                    ...(options.sort && { sort: options.sort }),
                    page: currentPage.toString(),
                    per_page: "100",
                });

                const response = await fetch(
                    `${this.gitlabBaseUrl}/api/v4/projects?${queryParams}`,
                    {
                        headers: {
                            Authorization: `Bearer ${this.gitlabToken}`,
                            "Content-Type": "application/json",
                        },
                    }
                );

                if (!response.ok) {
                    throw new Error(`Failed to list projects: ${response.statusText}`);
                }

                const projects = (await response.json()) as GitLabProject[];
                allProjects.push(...projects);

                const nextPage = response.headers.get("X-Next-Page");
                hasNextPage = !!nextPage;
                currentPage++;
            }

            return allProjects;
        } catch (error) {
            console.error("Error listing projects:", error);
            throw new Error(
                `Failed to list projects: ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    async getToken(): Promise<string | undefined> {
        if (!this.gitlabToken) {
            await this.initialize();
        }
        return this.gitlabToken;
    }

    getBaseUrl(): string | undefined {
        return this.gitlabBaseUrl;
    }

    async getUserInfo(): Promise<{ email: string; username: string; group?: string }> {
        try {
            const user = await this.getCurrentUser();
            return {
                email: user.email,
                username: user.username,
                group: user.group,
            };
        } catch (error) {
            console.error("Failed to get user info:", error);
            throw new Error("Failed to get user information");
        }
    }
}
