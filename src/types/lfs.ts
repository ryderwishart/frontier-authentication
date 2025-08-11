// Types for Git LFS batch API and upload flow

export interface LfsAuth {
    username?: string;
    password?: string;
    token?: string;
}

export interface UploadBlobsOptions {
    headers?: Record<string, string>;
    url: string;
    auth?: LfsAuth;
}

export interface LFSAction {
    href: string;
    header?: Record<string, string>;
    expires_at?: string;
    expires_in?: number;
}

export interface LFSObject {
    oid: string;
    size: number;
    actions?: {
        upload?: LFSAction;
        download?: LFSAction;
        verify?: LFSAction;
    };
    error?: {
        code: number;
        message: string;
    };
}

export interface LFSBatchRequest {
    operation: "download" | "upload";
    transfers: string[];
    objects: Array<{ oid: string; size: number }>;
}

export interface LFSBatchResponse {
    transfer?: string;
    objects: LFSObject[];
}

// Minimal shape accepted by lfs.formatPointerInfo
export interface LfsPointerInfo {
    oid: string;
    size: number;
    // Allow library-specific extras without forcing any
    [key: string]: unknown;
}
