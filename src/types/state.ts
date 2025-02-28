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

export interface GitLabCredentials {
    token: string;
    url: string;
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
}

export interface GlobalState {
    auth: AuthState;
    syncLock?: {
        isLocked: boolean;
        timestamp: number;
    };
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
