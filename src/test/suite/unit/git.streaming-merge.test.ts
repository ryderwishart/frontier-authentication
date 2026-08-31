import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import * as dugiteGit from "../../../git/dugiteGit";
import { GitService } from "../../../git/GitService";
import type { StateManager } from "../../../state";
import type { MergeSnapshot } from "../../../git/mergeSnapshot";
import { buildPointerInfo, formatPointerInfo } from "../../../git/lfsPointerUtils";

type Strategy = "stream-only" | "stream-and-save" | "auto-download";
type ServiceInternals = {
    isOnline: () => Promise<boolean>;
    safePush: () => Promise<void>;
    reconcilePointersFilesystem: (dir: string, credentials: typeof auth) => Promise<void>;
    stageResolvedFileWithLFS: (dir: string, file: string, credentials: typeof auth) => Promise<void>;
};
const auth = { username: "test", password: "test" };
const author = { name: "Sync regression test", email: "test@example.invalid" };
const audioPath = ".project/attachments/pointers/BOOK/audio.wav";
const media = Buffer.from("test audio content");
const pointer = Buffer.from(formatPointerInfo(buildPointerInfo(media)));

suite("GitService: streaming merge regression", function () {
    this.timeout(120000);
    let dir: string;
    let service: GitService;
    let internal: ServiceInternals;
    let mode: Strategy;
    let networkRequests: number;
    let pushes: number;
    let fetchHook: (() => void) | undefined;
    let originalFetch: typeof globalThis.fetch;
    const originalFetchOrigin = dugiteGit.fetchOrigin;
    const originalReadBlob = dugiteGit.readBlobAtRef;

    function git(...args: string[]): string {
        return execFileSync("git", [
            "-c", "filter.lfs.process=", "-c", "filter.lfs.clean=cat",
            "-c", "filter.lfs.smudge=cat", "-c", "filter.lfs.required=false",
            "-c", "commit.gpgsign=false", ...args,
        ], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    }
    function write(file: string, bytes: Uint8Array | string): void {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), bytes);
    }
    function commit(message: string): string {
        git("add", ".");
        git("commit", "-qm", message);
        return git("rev-parse", "HEAD");
    }
    function divergentPointers(count: number, pointersInBase = false): MergeSnapshot {
        const paths = Array.from({ length: count }, (_, i) => `.project/attachments/pointers/BOOK/audio-${i}.wav`);
        if (pointersInBase) {
            for (const file of paths) { write(file, formatPointerInfo(buildPointerInfo(Buffer.from("base audio")))); }
            commit("base pointers");
        }
        const baseHead = git("rev-parse", "HEAD");
        for (const file of paths) { write(file, pointer); }
        const localHead = commit("local adds pointers");
        git("checkout", "-qb", "remote", baseHead);
        for (const file of paths) { write(file, pointer); }
        const remoteHead = commit("remote independently adds matching pointers");
        git("checkout", "-q", "main");
        git("update-ref", "refs/remotes/origin/main", remoteHead);
        return { localHead, remoteHead, baseHead };
    }
    function remoteAdvance(): void {
        const local = git("rev-parse", "HEAD");
        git("checkout", "-q", "remote");
        write("new-remote.txt", "must never be lost");
        const remote = commit("new remote change during resolution");
        git("checkout", "-q", "main");
        assert.strictEqual(git("rev-parse", "HEAD"), local);
        git("update-ref", "refs/remotes/origin/main", remote);
    }

    suiteSetup(async () => {
        // Finish extension activation before selecting a backend in each test.
        await vscode.extensions.getExtension("frontier-rnd.frontier-authentication")?.activate();
    });

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-streaming-merge-"));
        git("init", "-q", "-b", "main");
        git("config", "core.autocrlf", "false");
        git("config", "user.name", author.name);
        git("config", "user.email", author.email);
        git("remote", "add", "origin", "https://example.invalid/project.git");
        write(".gitignore", ".project/attachments/files/\n.project/localProjectSettings.json\n");
        commit("base");
        mode = "stream-only";
        pushes = 0;
        networkRequests = 0;
        fetchHook = undefined;
        let locked = false;
        const state = {
            isSyncLocked: () => locked,
            acquireSyncLock: async () => { locked = true; return true; },
            releaseSyncLock: async () => { locked = false; },
            updateLockHeartbeat: async () => {},
            getRepoStrategy: () => mode,
            setRepoStrategy: async () => {},
            incrementMetric: () => {},
        } as unknown as StateManager;
        service = new GitService(state);
        internal = service as unknown as ServiceInternals;
        internal.isOnline = async () => true;
        internal.safePush = async () => {
            pushes++;
            git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
        };
        const locator = process.platform === "win32" ? "where.exe" : "which";
        const executable = execFileSync(locator, ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
        const gitRoot = path.dirname(path.dirname(executable));
        const execPath = execFileSync(executable, ["--exec-path"], { encoding: "utf8" }).trim();
        dugiteGit.setGitBinaryPath(gitRoot, execPath);
        (dugiteGit as { fetchOrigin: typeof originalFetchOrigin }).fetchOrigin = async () => { fetchHook?.(); };
        originalFetch = globalThis.fetch;
        globalThis.fetch = async () => { networkRequests++; throw new Error("Unexpected HTTP request in streaming sync"); };
    });
    teardown(() => {
        (dugiteGit as { fetchOrigin: typeof originalFetchOrigin }).fetchOrigin = originalFetchOrigin;
        (dugiteGit as { readBlobAtRef: typeof originalReadBlob }).readBlobAtRef = originalReadBlob;
        globalThis.fetch = originalFetch;
        dugiteGit.setForceBuiltin(false);
        dugiteGit.useEmbeddedGitBinary();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    for (const builtin of [false, true]) {
        for (const strategy of ["stream-only", "stream-and-save"] as const) {
            test(`identical pointers converge with no media requests (${strategy}, ${builtin ? "builtin" : "native"})`, async () => {
                dugiteGit.setForceBuiltin(builtin);
                mode = strategy;
                const expected = divergentPointers(5);
                const first = await service.syncChanges(dir, auth, author);
                assert.strictEqual(first.hadConflicts, true, "divergent histories still need merging");
                assert.deepStrictEqual(first.conflicts, []);
                assert.deepStrictEqual(first.mergeSnapshot, expected);
                const tree = git("rev-parse", "HEAD^{tree}");
                await service.completeMerge(dir, auth, author, [], first.mergeSnapshot);
                assert.strictEqual(git("rev-parse", "HEAD^{tree}"), tree);
                assert.strictEqual(git("rev-list", "--parents", "-n1", "HEAD").split(" ").length, 3);
                const head = git("rev-parse", "HEAD");
                const next = await service.syncChanges(dir, auth, author);
                assert.strictEqual(next.hadConflicts, false);
                assert.strictEqual(git("rev-parse", "HEAD"), head);
                assert.strictEqual(git("status", "--porcelain"), "");
                assert.strictEqual(networkRequests, 0);
            });
        }
    }

    test("1,500 identical modified pointers are excluded with bounded blob reads", async () => {
        const expected = divergentPointers(1500, true);
        let active = 0;
        let peak = 0;
        (dugiteGit as { readBlobAtRef: typeof originalReadBlob }).readBlobAtRef = async (...args) => {
            active++;
            peak = Math.max(peak, active);
            try { return await originalReadBlob(...args); } finally { active--; }
        };
        const result = await service.syncChanges(dir, auth, author);
        assert.deepStrictEqual(result.conflicts, []);
        assert.deepStrictEqual(result.mergeSnapshot, expected);
        assert.ok(peak <= 8, `Unbounded blob reads: ${peak}`);
        assert.strictEqual(networkRequests, 0);
    });

    for (const strategy of ["stream-only", "stream-and-save", "auto-download"] as const) {
        test(`stages the resolved pointer rather than the old HEAD pointer (${strategy})`, async () => {
            mode = strategy;
            write(audioPath, pointer);
            commit("old pointer");
            const replacement = Buffer.from(formatPointerInfo(buildPointerInfo(Buffer.from("new audio"))));
            write(audioPath, replacement);
            await internal.stageResolvedFileWithLFS(dir, audioPath, auth);
            assert.strictEqual(git("show", `:${audioPath}`), replacement.toString().trim());
            assert.strictEqual(networkRequests, 0, "staging must never hydrate media");
        });
    }

    test("stages a newly created pointer without downloading", async () => {
        write(audioPath, pointer);
        await internal.stageResolvedFileWithLFS(dir, audioPath, auth);
        assert.strictEqual(git("show", `:${audioPath}`), pointer.toString().trim());
        assert.strictEqual(networkRequests, 0);
    });

    test("refuses a remote that advanced during the completion fetch before staging or committing", async () => {
        const expected = divergentPointers(2);
        const indexTree = git("write-tree");
        fetchHook = () => { fetchHook = undefined; remoteAdvance(); };
        await assert.rejects(service.completeMerge(dir, auth, author, [], expected), /MERGE_STATE_CHANGED:/);
        assert.strictEqual(git("rev-parse", "HEAD"), expected.localHead);
        assert.strictEqual(git("write-tree"), indexTree);
        assert.strictEqual(pushes, 0);
        const next = await service.syncChanges(dir, auth, author);
        assert.ok(next.conflicts?.some((file) => file.filepath === "new-remote.txt" && file.theirs === "must never be lost"));
    });

    test("refuses a local commit made after conflict analysis", async () => {
        const expected = divergentPointers(1);
        write("local-edit.txt", "new local work");
        const head = commit("local user commit");
        await assert.rejects(service.completeMerge(dir, auth, author, [], expected), /MERGE_STATE_CHANGED:/);
        assert.strictEqual(git("rev-parse", "HEAD"), head);
        assert.strictEqual(pushes, 0);
    });

    test("an unreadable existing blob aborts analysis rather than appearing empty", async () => {
        divergentPointers(2);
        (dugiteGit as { readBlobAtRef: typeof originalReadBlob }).readBlobAtRef = async () => { throw new Error("simulated missing object"); };
        await assert.rejects(service.syncChanges(dir, auth, author), /BLOB_READ_FAILED:/);
        assert.strictEqual(pushes, 0);
    });

    test("a failed push can retry without recreating the already completed merge", async () => {
        const expected = divergentPointers(2);
        const safePush = internal.safePush;
        internal.safePush = async () => { throw new Error("network unavailable"); };
        await assert.rejects(service.completeMerge(dir, auth, author, [], expected), /Failed to push/);
        const merged = git("rev-parse", "HEAD");
        assert.notStrictEqual(merged, expected.localHead);
        internal.safePush = safePush;
        const next = await service.syncChanges(dir, auth, author);
        assert.strictEqual(next.hadConflicts, false);
        assert.strictEqual(git("rev-parse", "HEAD"), merged);
        assert.strictEqual(networkRequests, 0);
    });

    test("auto-download preserves mismatched media and hydrates only pointer placeholders", async () => {
        mode = "auto-download";
        write(audioPath, pointer);
        commit("pointer for cache test");
        const cachePath = audioPath.replace("/pointers/", "/files/");
        write(cachePath, media);
        await internal.reconcilePointersFilesystem(dir, auth);
        assert.strictEqual(networkRequests, 0, "valid cache must not be downloaded");

        const info = buildPointerInfo(media);
        globalThis.fetch = async (input) => {
            networkRequests++;
            if (String(input).endsWith("/objects/batch")) {
                return new Response(JSON.stringify({ objects: [{ ...info, actions: { download: { href: "https://example.invalid/audio" } } }] }));
            }
            return new Response(media.toString());
        };
        const localRecording = Buffer.alloc(media.length, 88); // same size, different recording
        write(cachePath, localRecording);
        await internal.reconcilePointersFilesystem(dir, auth);
        assert.strictEqual(networkRequests, 0, "unknown local bytes must not trigger a replacement download");
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), localRecording);

        write(cachePath, pointer); // an existing placeholder is not downloaded audio
        await internal.reconcilePointersFilesystem(dir, auth);
        assert.strictEqual(networkRequests, 2);
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), media);
        await internal.reconcilePointersFilesystem(dir, auth);
        assert.strictEqual(networkRequests, 2, "the next reconciliation must use the valid cache");
    });

    test("an invalid download cannot overwrite the existing cache", async () => {
        mode = "auto-download";
        write(audioPath, pointer);
        commit("pointer for corrupt download test");
        const cachePath = audioPath.replace("/pointers/", "/files/");
        const existing = pointer; // eligible for hydration, so verification is actually exercised
        write(cachePath, existing);
        const info = buildPointerInfo(media);
        globalThis.fetch = async (input) => {
            networkRequests++;
            if (String(input).endsWith("/objects/batch")) {
                return new Response(JSON.stringify({ objects: [{ ...info, actions: { download: { href: "https://example.invalid/audio" } } }] }));
            }
            return new Response("corrupt response");
        };
        await internal.reconcilePointersFilesystem(dir, auth);
        assert.strictEqual(networkRequests, 2, "must validate a downloaded response, not skip the test");
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, cachePath)), existing);
    });

    test("equivalent LFS worktree bytes do not generate empty commits on repeated syncs", async () => {
        write(".gitattributes", "*.wav filter=lfs diff=lfs merge=lfs -text\n");
        write("media.wav", pointer);
        const original = commit("tracked LFS pointer");
        write("media.wav", media);
        internal.isOnline = async () => false;
        for (let i = 0; i < 2; i++) {
            const result = await service.syncChanges(dir, auth, author);
            assert.strictEqual(result.offline, true);
            assert.strictEqual(git("rev-parse", "HEAD"), original);
        }
        assert.strictEqual(networkRequests, 0);
    });

    test("genuine staged text changes still commit exactly once", async () => {
        write("local.txt", "new local content");
        internal.isOnline = async () => false;
        await service.syncChanges(dir, auth, author);
        const committed = git("rev-parse", "HEAD");
        assert.strictEqual(git("show", "HEAD:local.txt"), "new local content");
        await service.syncChanges(dir, auth, author);
        assert.strictEqual(git("rev-parse", "HEAD"), committed);
    });

    test("batch staging a new pointer in streaming mode does not download its media", async () => {
        write(".gitattributes", "*.wav filter=lfs diff=lfs merge=lfs -text\n");
        commit("LFS rules");
        write(audioPath, pointer);
        await service.addAllWithLFS(dir, auth);
        assert.strictEqual(git("show", `:${audioPath}`), pointer.toString().trim());
        assert.strictEqual(networkRequests, 0);
    });

    test("an in-progress atomic save is not staged or committed", async () => {
        const original = git("rev-parse", "HEAD");
        write("file.codex.tmp-1788100000000-00000000-0000-4000-8000-000000000000", "partial JSON");
        internal.isOnline = async () => false;
        await service.syncChanges(dir, auth, author);
        assert.strictEqual(git("rev-parse", "HEAD"), original);
        assert.strictEqual(git("diff", "--cached", "--name-only"), "");
    });

    test("auto-download retains source-repository recovery for missing media objects", async () => {
        mode = "auto-download";
        write(audioPath, pointer);
        write(".project/localProjectSettings.json", JSON.stringify({
            currentMediaFilesStrategy: mode,
            lfsSourceRemoteUrl: "https://example.invalid/source.git",
        }));
        commit("pointer requiring source recovery");
        const info = buildPointerInfo(media);
        let uploaded = false;
        let sourceDownloads = 0;
        globalThis.fetch = async (input, init) => {
            const url = String(input);
            if (url.endsWith("/objects/batch")) {
                const request = JSON.parse(String(init?.body)) as { operation: string };
                if (request.operation === "upload") {
                    return new Response(JSON.stringify({ objects: [{ ...info, actions: { upload: { href: "https://example.invalid/upload" } } }] }));
                }
                const source = url.includes("source.git");
                if (source) { sourceDownloads++; }
                const actions = source || uploaded ? { download: { href: "https://example.invalid/audio" } } : {};
                return new Response(JSON.stringify({ objects: [{ ...info, actions }] }));
            }
            if (url.endsWith("/upload")) {
                uploaded = true;
                return new Response("", { status: 200 });
            }
            if (url.endsWith("/audio")) { return new Response(media.toString()); }
            throw new Error(`Unexpected recovery request: ${url}`);
        };
        await internal.reconcilePointersFilesystem(dir, auth);
        assert.strictEqual(sourceDownloads, 1);
        assert.strictEqual(uploaded, true);
        assert.deepStrictEqual(fs.readFileSync(path.join(dir, audioPath.replace("/pointers/", "/files/"))), media);
    });
});
