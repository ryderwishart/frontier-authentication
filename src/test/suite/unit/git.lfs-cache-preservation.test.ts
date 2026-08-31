import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { inspectLfsCache } from "../../../git/lfsCacheValidation";
import { writeLfsCacheIfMissing, writeLfsCacheSafely } from "../../../git/lfsCacheWrite";
import { buildPointerInfo, formatPointerInfo } from "../../../git/lfsPointerUtils";

suite("LFS cache: preserve local bytes during publication", () => {
    let dir: string;
    let file: string;
    const media = Buffer.from("remote media verified against its pointer");
    const info = buildPointerInfo(media);
    const pointer = Buffer.from(formatPointerInfo(info));
    const local = Buffer.from("only copy of a newer local recording");
    const originalLink = fs.promises.link;
    const originalRename = fs.promises.rename;
    const originalOpen = fs.promises.open;
    const originalLstat = fs.promises.lstat;
    const publish = () => writeLfsCacheSafely(file, media, info, async () => true);

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-cache-preservation-"));
        file = path.join(dir, "recording.wav");
    });
    teardown(() => {
        fs.promises.link = originalLink;
        fs.promises.rename = originalRename;
        fs.promises.open = originalOpen;
        fs.promises.lstat = originalLstat;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("distinguishes missing, matching, placeholder and unknown media", async () => {
        assert.strictEqual(await inspectLfsCache(file, info), "missing");
        for (const [bytes, expected] of [
            [media, "matching"], [pointer, "placeholder"],
            [Buffer.from("\uFEFF" + pointer.toString().replace(/\n/g, "\r\n")), "placeholder"],
            [Buffer.alloc(media.length, 88), "protected"], [Buffer.alloc(0), "protected"],
            [Buffer.concat([pointer, local]), "protected"],
        ] as const) {
            fs.writeFileSync(file, bytes);
            assert.strictEqual(await inspectLfsCache(file, info), expected);
        }
        fs.writeFileSync(file, pointer);
        assert.strictEqual(await inspectLfsCache(file, buildPointerInfo(pointer)), "matching");
    });

    test("validates larger cached media without confusing equal-size bytes", async () => {
        const large = Buffer.alloc(1024 * 1024, 47);
        fs.writeFileSync(file, large);
        assert.strictEqual(await inspectLfsCache(file, buildPointerInfo(large)), "matching");
        large[large.length - 1]++;
        assert.strictEqual(await inspectLfsCache(file, buildPointerInfo(large)), "protected");
    });

    test("symlinks and directories are never eligible for replacement", async () => {
        const target = path.join(dir, "target.wav");
        fs.writeFileSync(target, local);
        fs.symlinkSync(target, file);
        assert.strictEqual(await inspectLfsCache(file, info), "protected");
        assert.strictEqual((await publish()).status, "preserved");
        assert.deepStrictEqual(fs.readFileSync(target), local);
        fs.unlinkSync(file);
        fs.mkdirSync(file);
        assert.strictEqual(await inspectLfsCache(file, info), "protected");
        assert.strictEqual((await publish()).status, "preserved");
    });

    test("stat and read failures are protected, not mistaken for missing files", async () => {
        fs.writeFileSync(file, local);
        fs.promises.lstat = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
        assert.strictEqual(await inspectLfsCache(file, info), "protected");
        fs.promises.lstat = originalLstat;
        fs.promises.open = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
        assert.strictEqual(await inspectLfsCache(file, info), "protected");
        assert.strictEqual((await publish()).status, "preserved");
        assert.deepStrictEqual(fs.readFileSync(file), local);
    });

    test("publishes complete media into a missing path without leaving temporary files", async () => {
        assert.strictEqual((await publish()).status, "written");
        assert.deepStrictEqual(fs.readFileSync(file), media);
        assert.deepStrictEqual(fs.readdirSync(dir), ["recording.wav"]);
    });

    test("hydrates a recognized placeholder and retains its prior inode", async () => {
        fs.writeFileSync(file, pointer);
        const result = await publish();
        assert.strictEqual(result.status, "written");
        assert.deepStrictEqual(fs.readFileSync(file), media);
        assert.ok(result.recoveryPath);
        assert.deepStrictEqual(fs.readFileSync(result.recoveryPath!), pointer);
        assert.deepStrictEqual(fs.readdirSync(path.dirname(result.recoveryPath!)), [path.basename(result.recoveryPath!)]);
    });

    test("does not overwrite a recording created immediately before publication", async () => {
        fs.promises.link = async (source, destination) => {
            if (destination === file) { fs.writeFileSync(file, local); }
            return originalLink(source, destination);
        };
        assert.strictEqual((await publish()).status, "preserved");
        assert.deepStrictEqual(fs.readFileSync(file), local);
        assert.deepStrictEqual(fs.readdirSync(dir), ["recording.wav"]);
    });

    test("restores a recording that replaced the placeholder immediately before it was moved", async () => {
        fs.writeFileSync(file, pointer);
        fs.promises.rename = async (source, destination) => {
            if (source === file) { fs.writeFileSync(file, local); }
            return originalRename(source, destination);
        };
        const result = await publish();
        assert.strictEqual(result.status, "preserved");
        assert.deepStrictEqual(fs.readFileSync(file), local);
        assert.deepStrictEqual(fs.readFileSync(result.recoveryPath!), local);
    });

    test("keeps both recordings if the destination is also recreated before restoration", async () => {
        fs.writeFileSync(file, pointer);
        const later = Buffer.from("another local save");
        fs.promises.rename = async (source, destination) => {
            fs.writeFileSync(file, local);
            await originalRename(source, destination);
            fs.writeFileSync(file, later);
        };
        const result = await publish();
        assert.strictEqual(result.status, "preserved");
        assert.deepStrictEqual(fs.readFileSync(file), later);
        assert.deepStrictEqual(fs.readFileSync(result.recoveryPath!), local);
    });

    test("retains writes through a descriptor that was open before placeholder replacement", async () => {
        fs.writeFileSync(file, pointer);
        const handle = await fs.promises.open(file, "r+");
        try {
            const result = await publish();
            assert.strictEqual(result.status, "written");
            await handle.truncate(0);
            await handle.writeFile(local);
            assert.deepStrictEqual(fs.readFileSync(result.recoveryPath!), local);
            assert.deepStrictEqual(fs.readFileSync(file), media);
        } finally { await handle.close(); }
    });

    test("restores the placeholder if the pointer changes while it is being moved", async () => {
        fs.writeFileSync(file, pointer);
        let current = true;
        fs.promises.rename = async (source, destination) => {
            await originalRename(source, destination);
            current = false;
        };
        const result = await writeLfsCacheSafely(file, media, info, async () => current);
        assert.strictEqual(result.status, "pointer-changed");
        assert.deepStrictEqual(fs.readFileSync(file), pointer);
    });

    test("unsupported hard links fail before moving an existing placeholder", async () => {
        fs.writeFileSync(file, pointer);
        fs.promises.link = async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); };
        await assert.rejects(publish(), /unsupported/);
        assert.deepStrictEqual(fs.readFileSync(file), pointer);
        assert.deepStrictEqual(fs.readdirSync(dir), ["recording.wav"]);
    });

    test("a failed publication restores the prior placeholder", async () => {
        fs.writeFileSync(file, pointer);
        fs.promises.link = async (source, destination) => {
            if (path.basename(String(source)) === "download" && destination === file) {
                throw Object.assign(new Error("publication failed"), { code: "EIO" });
            }
            return originalLink(source, destination);
        };
        await assert.rejects(publish(), /publication failed/);
        assert.deepStrictEqual(fs.readFileSync(file), pointer);
    });

    test("pointer population leaves all existing cache entries intact", async () => {
        for (const bytes of [local, media, pointer]) {
            fs.writeFileSync(file, bytes);
            assert.strictEqual(await writeLfsCacheIfMissing(file, pointer), false);
            assert.deepStrictEqual(fs.readFileSync(file), bytes);
        }
        fs.unlinkSync(file);
        assert.strictEqual(await writeLfsCacheIfMissing(file, pointer), true);
        assert.deepStrictEqual(fs.readFileSync(file), pointer);
    });

    test("pointer population cannot overwrite a recording arriving during the copy", async () => {
        fs.promises.link = async (source, destination) => {
            if (destination === file) { fs.writeFileSync(file, local); }
            return originalLink(source, destination);
        };
        assert.strictEqual(await writeLfsCacheIfMissing(file, pointer), false);
        assert.deepStrictEqual(fs.readFileSync(file), local);
    });
});
