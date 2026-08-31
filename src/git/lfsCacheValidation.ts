import * as fs from "fs";
import { createHash } from "crypto";
import type { LfsPointerInfo } from "../types/lfs";

export type LfsCacheState = "missing" | "placeholder" | "matching" | "protected";

/** Only recognize complete, small LFS pointers, never a pointer embedded in media. */
function isPointerPlaceholder(bytes: Buffer): boolean {
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    return /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:[0-9a-f]{64}\r?\nsize (0|[1-9][0-9]*)\r?\n?$/i.test(text);
}

export function canHydrateLfsCache(state: LfsCacheState): boolean {
    return state === "missing" || state === "placeholder";
}

/**
 * A mismatch is not proof of a stale cache: the editor saves media before its
 * pointer, and that pointer write can fail. Preserve unknown or unreadable bytes.
 */
export async function inspectLfsCache(filepath: string, pointer: LfsPointerInfo): Promise<LfsCacheState> {
    try {
        const stat = await fs.promises.lstat(filepath);
        if (!stat.isFile()) { return "protected"; }
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "protected";
    }

    try {
        const handle = await fs.promises.open(filepath,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        try {
            const before = await handle.stat();
            if (!before.isFile()) { return "protected"; }
            let placeholder = false;
            let matches = false;
            if (before.size <= 1024) {
                // Bound the read even if another writer grows the file after stat().
                const buffer = Buffer.alloc(1025);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                const bytes = buffer.subarray(0, bytesRead);
                matches = bytesRead === pointer.size && createHash("sha256").update(bytes).digest("hex") === pointer.oid;
                placeholder = bytesRead <= 1024 && isPointerPlaceholder(bytes);
            } else if (before.size === pointer.size) {
                const hash = createHash("sha256");
                for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); }
                matches = hash.digest("hex") === pointer.oid;
            }
            const after = await handle.stat();
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
                return "protected";
            }
            if (matches) { return "matching"; }
            return placeholder ? "placeholder" : "protected";
        } finally {
            await handle.close();
        }
    } catch {
        // Includes a deletion/replacement during inspection. A later sync can retry.
        return "protected";
    }
}
