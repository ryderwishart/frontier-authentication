import * as fs from "fs";
import * as path from "path";
import type { LfsPointerInfo } from "../types/lfs";
import { canHydrateLfsCache, inspectLfsCache } from "./lfsCacheValidation";

export interface LfsCacheWriteResult {
    status: "written" | "matching" | "preserved" | "pointer-changed";
    recoveryPath?: string;
}

async function withStagedCacheFile<T>(
    filepath: string, bytes: Uint8Array, publish: (staged: string, workdir: string) => Promise<T>,
): Promise<T> {
    await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
    // Stay on the same filesystem and inside the ignored files/ cache subtree.
    const workdir = await fs.promises.mkdtemp(path.join(path.dirname(filepath), ".frontier-lfs-"));
    const staged = path.join(workdir, "download");
    try {
        const handle = await fs.promises.open(staged, "wx");
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
        }
        return await publish(staged, workdir);
    } finally {
        await fs.promises.unlink(staged).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") { console.warn(`[GitService] Could not remove download temporary file ${staged}:`, error); }
        });
        // Never recursively remove this directory: it may hold local recovery data.
        await fs.promises.rmdir(workdir).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
                console.warn(`[GitService] Could not remove download temporary directory ${workdir}:`, error);
            }
        });
    }
}

/** Populate a cache entry without replacing any existing file, including placeholders. */
export async function writeLfsCacheIfMissing(filepath: string, bytes: Uint8Array): Promise<boolean> {
    try {
        await fs.promises.lstat(filepath);
        return false;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
    }
    return withStagedCacheFile(filepath, bytes, async (staged) => {
        try {
            await fs.promises.link(staged, filepath);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") { return false; }
            throw error;
        }
    });
}

/**
 * Publish verified download bytes without overwriting a concurrent recording.
 * A hard link makes publication atomic and refuses an occupied destination.
 * Do not fall back to writeFile/rename-over: those can destroy new local bytes.
 */
export async function writeLfsCacheSafely(
    filepath: string,
    bytes: Uint8Array,
    pointer: LfsPointerInfo,
    pointerStillCurrent: () => Promise<boolean>,
): Promise<LfsCacheWriteResult> {
    if (!await pointerStillCurrent()) { return { status: "pointer-changed" }; }
    const initial = await inspectLfsCache(filepath, pointer);
    if (!canHydrateLfsCache(initial)) {
        return { status: initial === "matching" ? "matching" : "preserved" };
    }

    return withStagedCacheFile<LfsCacheWriteResult>(filepath, bytes, async (staged, workdir) => {
        const recoveryPath = path.join(workdir, `preserved-${path.basename(filepath)}`);
        let moved = false;
        let published = false;
        try {
            if (!await pointerStillCurrent()) { return { status: "pointer-changed" }; }
            const current = await inspectLfsCache(filepath, pointer);
            if (!canHydrateLfsCache(current)) {
                return { status: current === "matching" ? "matching" : "preserved" };
            }
            if (current === "placeholder") {
                // Check hard-link support before moving an existing file. Unsupported
                // filesystems fail safely with the original placeholder still in place.
                const probe = path.join(workdir, "link-check");
                await fs.promises.link(staged, probe);
                await fs.promises.unlink(probe);
                try {
                    await fs.promises.rename(filepath, recoveryPath);
                    moved = true;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
                }
                // The editor may have replaced the placeholder immediately before rename.
                // Inspect the file actually moved, not the earlier observation.
                if (moved && await inspectLfsCache(recoveryPath, pointer) !== "placeholder") {
                    return { status: "preserved", recoveryPath };
                }
            }
            if (!await pointerStillCurrent()) {
                return { status: "pointer-changed", recoveryPath: moved ? recoveryPath : undefined };
            }
            try {
                await fs.promises.link(staged, filepath);
                published = true;
                return { status: "written", recoveryPath: moved ? recoveryPath : undefined };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                    return { status: "preserved", recoveryPath: moved ? recoveryPath : undefined };
                }
                throw error;
            }
        } finally {
            if (moved && !published) {
                try {
                    // Restore without replacing another file created in the meantime.
                    await fs.promises.link(recoveryPath, filepath);
                } catch (error) {
                    console.warn(`[GitService] Media retained for recovery at ${recoveryPath}; original path could not be restored:`, error);
                }
            }
            // Keep moved files, even apparent placeholders: an editor can still hold
            // an open descriptor to that inode and write a recording after our check.
        }
    });
}
