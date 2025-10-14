export interface GitLabInfo {
    username: string;
    project_count: number;
    user_id: number;
    groups?: Array<{
        id: string;
        name: string;
        path: string;
    }>;
}

export type MediaFilesStrategy =
    | "auto-download"
    | "stream-and-save"
    | "stream-only";

export interface GitLabCredentials {
    token: string;
    url: string;
}

export interface UserInfo {
    email: string;
    username: string;
    name?: string;
}

export interface AuthState {
    isAuthenticated: boolean;
    connectionStatus: "connected" | "disconnected";
    currentView: "login" | "register";
    gitlabInfo?: GitLabInfo;
    gitlabCredentials?: GitLabCredentials;
    lastSyncTimestamp?: number;
    username?: string;
    user_id?: number;
    project_count?: number;
    userInfo?: UserInfo; // Cached user information from authentication
}

export interface GlobalState {
    auth: AuthState;
    /** Per-repository media strategy keyed by absolute workspace path */
    repoStrategies?: Record<string, MediaFilesStrategy>;
}

// Add some type guards for better type safety
export const isGitLabInfo = (obj: any): obj is GitLabInfo => {
    return (
        typeof obj === "object" &&
        typeof obj.username === "string" &&
        typeof obj.project_count === "number" &&
        typeof obj.user_id === "number"
    );
};

export const isGitLabCredentials = (obj: any): obj is GitLabCredentials => {
    return typeof obj === "object" && typeof obj.token === "string" && typeof obj.url === "string";
};

