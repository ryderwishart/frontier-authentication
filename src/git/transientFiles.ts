/** Sibling files used by Codex atomic saves; never sync an unfinished save. */
export function isAtomicSaveTemp(filepath: string): boolean {
    return /\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filepath);
}
