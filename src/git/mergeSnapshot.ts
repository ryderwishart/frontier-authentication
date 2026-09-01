/** Commits whose contents were used to produce the conflict list. */
export interface MergeSnapshot {
    localHead: string;
    remoteHead: string;
    baseHead?: string;
}

export function assertMergeSnapshot(expected: MergeSnapshot, current: MergeSnapshot): void {
    if (expected.localHead !== current.localHead || expected.remoteHead !== current.remoteHead) {
        throw new Error(
            "MERGE_STATE_CHANGED: Local or remote history changed during conflict resolution. " +
            "No merge commit was created; sync must analyse the new changes before retrying."
        );
    }
}
