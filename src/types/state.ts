export interface AuthState {
    isAuthenticated: boolean;
    connectionStatus: 'connected' | 'disconnected';
    currentView: 'login' | 'register';
    gitlabInfo?: {
        username: string;
        project_count: number;
        user_id: number;
    };
}

export interface GlobalState {
    auth: AuthState;
} 