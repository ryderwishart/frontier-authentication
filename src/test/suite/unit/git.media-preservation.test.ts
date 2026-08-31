import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as dugiteGit from "../../../git/dugiteGit";
import { GitService } from "../../../git/GitService";
import type { StateManager } from "../../../state";
import { buildPointerInfo, formatPointerInfo } from "../../../git/lfsPointerUtils";

type Strategy = "auto-download" | "stream-only" | "stream-and-save";
const auth = { username: "test", password: "test" };
const media = Buffer.from("previous uploaded recording");
const local = Buffer.from("new local recording whose pointer save failed");
const info = buildPointerInfo(media);
const pointer = Buffer.from(formatPointerInfo(info));
const pointerPath = ".project/attachments/pointers/BOOK/recording.wav";
const cachePath = pointerPath.replace("/pointers/", "/files/");

suite("GitService: media preservation across strategies", function () {
    this.timeout(30000);
    let dir: string;
    let service: GitService;
    let mode: Strategy;
    let requests: number;
    let onBatch: (() => void) | undefined;
    let onDownload: (() => void) | undefined;
    let originalFetch: typeof globalThis.fetch;
    let warnings: string[];
    const originalWarn = vscode.window.showWarningMessage;
    const originalClone = dugiteGit.clone;
    const write = (file: string, bytes: Uint8Array) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), bytes);
    };
    const reconcile = () => (service as unknown as {
        reconcilePointersFilesystem: (dir: string, credentials: typeof auth) => Promise<void>;
    }).reconcilePointersFilesystem(dir, auth);

    suiteSetup(async () => {
        await vscode.extensions.getExtension("frontier-rnd.frontier-authentication")?.activate();
    });
    setup(async () => {
        mode = "auto-download";
        requests = 0;
        onBatch = undefined;
        onDownload = undefined;
        warnings = [];
        vscode.window.showWarningMessage = async (message: string) => { warnings.push(message); return undefined; };
        dugiteGit.setForceBuiltin(true);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-media-preservation-"));
        await dugiteGit.init(dir);
        await dugiteGit.addRemote(dir, "origin", "https://example.invalid/project.git");
        write(".gitignore", Buffer.from(".project/attachments/files/\n"));
        write(pointerPath, pointer);
        await dugiteGit.addAll(dir);
        await dugiteGit.commit(dir, "previous recording", { name: "Test", email: "test@example.invalid" });
        service = new GitService({
            getRepoStrategy: () => mode,
            setRepoStrategy: async (_dir: string, strategy: Strategy) => { mode = strategy; },
            incrementMetric: () => {},
        } as unknown as StateManager);
        originalFetch = globalThis.fetch;
        globalThis.fetch = async (input) => {
            requests++;
            if (String(input).endsWith("/objects/batch")) {
                onBatch?.();
                return new Response(JSON.stringify({ objects: [{ ...info, actions: { download: { href: "https://example.invalid/media" } } }] }));
            }
            onDownload?.();
            return new Response(media.toString());
        };
    });
    teardown(() => {
        globalThis.fetch = originalFetch;
        vscode.window.showWarningMessage = originalWarn;
        (dugiteGit as { clone: typeof originalClone }).clone = originalClone;
        dugiteGit.setForceBuiltin(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    for (const strategy of ["auto-download", "stream-and-save", "stream-only"] as const) {
        test(`a failed pointer save never destroys the newer local recording (${strategy})`, async () => {
            mode = strategy;
            write(cachePath, local); // same path, old pointer still references remote media
            for (let attempt = 0; attempt < 2; attempt++) { await reconcile(); }
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), local);
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, pointerPath)), pointer);
            assert.strictEqual(requests, 0, "do not request older bytes as a replacement for uncertain local media");
            if (strategy === "auto-download") { assert.ok(warnings.some((message) => message.includes("protect local changes"))); }
        });
    }

    for (const strategy of ["stream-only", "stream-and-save"] as const) {
        test(`clone placeholder population preserves same-path recordings (${strategy})`, async () => {
            mode = strategy;
            write(cachePath, local);
            (dugiteGit as { clone: typeof originalClone }).clone = async () => {};
            await service.clone("https://example.invalid/project.git", dir, auth, strategy);
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), local);
            assert.strictEqual(requests, 0);
        });
        test(`restoring streaming mode after publish preserves same-path recordings (${strategy})`, async () => {
            write(cachePath, local);
            await service.restoreMediaStrategyAfterPublish(dir, strategy);
            assert.strictEqual(mode, strategy);
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), local);
            assert.strictEqual(requests, 0);
        });

    }

    test("a recording that arrives during the batch request prevents an unnecessary object download", async () => {
        onBatch = () => write(cachePath, local);
        await reconcile();
        assert.strictEqual(requests, 1, "batch only; do not GET the now-unneeded object");
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), local);
    });

    test("a recording that arrives during the object download is not overwritten", async () => {
        onDownload = () => write(cachePath, local);
        await reconcile();
        assert.strictEqual(requests, 2);
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), local);
        assert.ok(warnings.some((message) => message.includes("protect local changes")));
    });

    test("on-demand media arriving during the batch request is reused", async () => {
        onBatch = () => write(cachePath, media);
        await reconcile();
        assert.strictEqual(requests, 1);
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), media);
    });

    for (const change of ["pointer changed", "pointer removed", "pointer replaced with raw recording"] as const) {
        test(`an in-flight download is not installed when its ${change}`, async () => {
            onDownload = () => {
                if (change === "pointer removed") { fs.unlinkSync(path.join(dir, pointerPath)); }
                else { write(pointerPath, change === "pointer changed" ? formatPointerInfo(buildPointerInfo(local)) : local); }
            };
            await reconcile();
            assert.strictEqual(requests, 2);
            assert.strictEqual(fs.existsSync(path.join(dir, cachePath)), false);
            assert.ok(warnings.some((message) => message.includes("protect local changes")));
        });
    }

    for (const timing of ["before scan", "during batch", "during download"] as const) {
        test(`a protected target does not block another missing target sharing its OID (${timing})`, async () => {
            const otherPointer = pointerPath.replace("recording.wav", "other.wav");
            const otherCache = otherPointer.replace("/pointers/", "/files/");
            write(otherPointer, pointer);
            await dugiteGit.add(dir, otherPointer);
            await dugiteGit.commit(dir, "same remote media at another path", { name: "Test", email: "test@example.invalid" });
            if (timing === "before scan") { write(cachePath, local); }
            if (timing === "during batch") { onBatch = () => write(cachePath, local); }
            if (timing === "during download") { onDownload = () => write(cachePath, local); }
            await reconcile();
            assert.strictEqual(requests, 2, "one batch and one object GET for shared content");
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), local);
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, otherCache)), media);
        });
    }
    test("reconciliation waits for other media writes when one shared-OID target fails", async () => {
        const otherPointer = pointerPath.replace("recording.wav", "other.wav");
        const otherCache = path.join(dir, otherPointer.replace("/pointers/", "/files/"));
        write(otherPointer, pointer);
        await dugiteGit.add(dir, otherPointer);
        await dugiteGit.commit(dir, "shared media", { name: "Test", email: "test@example.invalid" });
        const originalLink = fs.promises.link;
        let releaseWrite!: () => void;
        let writeStarted!: () => void;
        let writeFailed!: () => void;
        const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
        const started = new Promise<void>((resolve) => { writeStarted = resolve; });
        const failed = new Promise<void>((resolve) => { writeFailed = resolve; });
        fs.promises.link = async (source, destination) => {
            if (destination === path.join(dir, cachePath)) {
                writeFailed();
                throw new Error("simulated destination write failure");
            }
            if (destination === otherCache) {
                writeStarted();
                await gate;
            }
            return originalLink(source, destination);
        };
        const syncing = reconcile();
        try {
            await Promise.all([started, failed]);
            const state = await Promise.race([
                syncing.then(() => "finished"),
                new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 25)),
            ]);
            assert.strictEqual(state, "waiting", "reconciliation must wait for the remaining write");
        } finally {
            releaseWrite();
            await syncing;
            fs.promises.link = originalLink;
        }
        assert.deepStrictEqual(fs.readFileSync(otherCache), media);
        assert.strictEqual(fs.existsSync(path.join(dir, cachePath)), false);
        assert.ok(warnings.some((message) => message.includes("could not be downloaded")));
    });

    test("publish source downloads preserve unknown local recordings", async () => {
        write(cachePath, local);
        assert.strictEqual(await service.downloadLfsObjectsForPublish(dir, auth, "https://example.invalid/source.git"), 0);
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), local);
        assert.strictEqual(requests, 0);
    });

    for (const existing of ["missing", "placeholder"] as const) {
        test(`publish source downloads still hydrate ${existing} cache entries`, async () => {
            if (existing === "placeholder") { write(cachePath, pointer); }
            assert.strictEqual(await service.downloadLfsObjectsForPublish(dir, auth, "https://example.invalid/source.git"), 1);
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), media);
            assert.strictEqual(requests, 2);
        });
    }

    test("publish source downloads cannot overwrite a recording saved during the request", async () => {
        onDownload = () => write(cachePath, local);
        assert.strictEqual(await service.downloadLfsObjectsForPublish(dir, auth, "https://example.invalid/source.git"), 0);
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), local);
        assert.strictEqual(requests, 2);
    });

    test("publish source downloads cannot install bytes for an obsolete pointer", async () => {
        onDownload = () => write(pointerPath, formatPointerInfo(buildPointerInfo(local)));
        assert.strictEqual(await service.downloadLfsObjectsForPublish(dir, auth, "https://example.invalid/source.git"), 0);
        assert.strictEqual(fs.existsSync(path.join(dir, cachePath)), false);
        assert.strictEqual(requests, 2);
    });

});
