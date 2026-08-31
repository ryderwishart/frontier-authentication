import * as fs from "fs";
import { createHash } from "crypto";

/** A files/ entry may be a pointer placeholder or stale media of the same size. */
export async function hasMatchingLfsCache(
    filepath: string, pointer: { oid: string; size: number }
): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(filepath);
        if (!stat.isFile() || stat.size !== pointer.size) { return false; }
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(filepath)) { hash.update(chunk); }
        return hash.digest("hex") === pointer.oid;
    } catch {
        return false;
    }
}
