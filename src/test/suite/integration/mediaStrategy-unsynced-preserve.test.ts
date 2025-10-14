import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";
import { GitLabService } from "../../../gitlab/GitLabService";
import { SCMManager } from "../../../scm/SCMManager";
import { StateManager } from "../../../state";

suite("Integration: unsynced local media preserved across strategies", () => {
    let workspaceDir: string;
    let originalFetch: any;
    let originalClone: any;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        (GitLabService as any).prototype.initializeWithRetry = async function () {
            this.gitlabToken = "mock-token";
            this.gitlabBaseUrl = "https://gitlab.example.com";
        };
        (GitLabService as any).prototype.getToken = async function () {
            this.gitlabToken = this.gitlabToken || "mock-token";
            return this.gitlabToken;
        };
        (GitLabService as any).prototype.getCurrentUser = async function () {
            return { id: 1, username: "tester", name: "Tester", email: "tester@example.com" };
        };
    });

    setup(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-unsynced-"));
        await git.init({ fs, dir: workspaceDir, defaultBranch: "main" });

        // Commit a pointer tracked by git
        const ptrRel = ".project/attachments/pointers/audio/remote.wav";
        const ptrAbs = path.join(workspaceDir, ptrRel);
        await fs.promises.mkdir(path.dirname(ptrAbs), { recursive: true });
        await fs.promises.writeFile(
            ptrAbs,
            [
                "version https://git-lfs.github.com/spec/v1",
                `oid sha256:${"f".repeat(64)}`,
                "size 11",
            ].join("\n"),
            "utf8"
        );
        await git.add({ fs, dir: workspaceDir, filepath: ptrRel });
        const head = await git.commit({ fs, dir: workspaceDir, message: "add ptr", author: { name: "T", email: "t@e" } });

        // Add a local-only unsynced recording (not tracked in git)
        const localOnlyAbs = path.join(workspaceDir, ".project/attachments/files/audio/local-only.wav");
        await fs.promises.mkdir(path.dirname(localOnlyAbs), { recursive: true });
        await fs.promises.writeFile(localOnlyAbs, Buffer.from("local-bytes"));

        // Set remote and ref
        await git.addRemote({ fs, dir: workspaceDir, remote: "origin", url: "https://example.com/repo.git" });
        await git.writeRef({ fs, dir: workspaceDir, ref: "refs/remotes/origin/main", value: head, force: true });

        // Stub clone to avoid network
        originalClone = (git as any).clone;
        (git as any).clone = async () => {};

        // Stub fetch for LFS
        originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";

            if (url.includes("/info/lfs/objects/batch") && method === "POST") {
                const bodyStr = init?.body ? init.body.toString() : "";
                const req = bodyStr ? JSON.parse(bodyStr) : { objects: [] };
                const objects = (req.objects || []).map((o: any) => ({
                    oid: o.oid,
                    size: o.size || 11,
                    actions: {
                        download: {
                            href: "https://lfs-download.example.com/obj",
                            header: { accept: "application/octet-stream" },
                        },
                    },
                }));
                return new Response(JSON.stringify({ objects }), {
                    status: 200,
                    headers: { "content-type": "application/vnd.git-lfs+json" },
                });
            }

            if (url.startsWith("https://lfs-download.example.com/") && method === "GET") {
                return new Response(Buffer.from("hello-remote"), { status: 200 });
            }

            return new Response("", { status: 200 });
        };

        // Initialize state manager
        const fakeContext: any = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        StateManager.initialize(fakeContext);

        // Patch workspace path getter
        (SCMManager as any).prototype.getWorkspacePath = function () { return workspaceDir; };
        (SCMManager as any).prototype.registerCommands = function () {};

        // Ensure getRemoteUrl works
        const { GitService } = require("../../../git/GitService");
        const originalGetRemoteUrl = GitService.prototype.getRemoteUrl;
        GitService.prototype.getRemoteUrl = async () => "https://example.com/repo.git";
        (global as any).__restoreGetRemoteUrl2 = () => { GitService.prototype.getRemoteUrl = originalGetRemoteUrl; };
    });

    teardown(async () => {
        (globalThis as any).fetch = originalFetch;
        if (originalClone) (git as any).clone = originalClone;
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
        if ((global as any).__restoreGetRemoteUrl2) { (global as any).__restoreGetRemoteUrl2(); delete (global as any).__restoreGetRemoteUrl2; }
    });

    test("auto-download downloads pointer and preserves local-only recording", async () => {
        const gl = new GitLabService({} as any);
        const scm = new SCMManager(gl, { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as any) as any;

        await scm.gitService.clone("https://example.com/repo.git", workspaceDir, { username: "oauth2", password: "mock-token" }, "auto-download");

        const remoteFilesAbs = path.join(workspaceDir, ".project/attachments/files/audio/remote.wav");
        const remoteBytes = await fs.promises.readFile(remoteFilesAbs);
        assert.strictEqual(remoteBytes.toString(), "hello-remote");

        const localOnlyAbs = path.join(workspaceDir, ".project/attachments/files/audio/local-only.wav");
        const localBytes = await fs.promises.readFile(localOnlyAbs);
        assert.strictEqual(localBytes.toString(), "local-bytes", "local-only should be preserved");
    });

    test("stream-only keeps local-only and does not download pointer", async () => {
        const gl = new GitLabService({} as any);
        const scm = new SCMManager(gl, { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as any) as any;

        await scm.gitService.clone("https://example.com/repo.git", workspaceDir, { username: "oauth2", password: "mock-token" }, "stream-only");

        const remoteFilesAbs = path.join(workspaceDir, ".project/attachments/files/audio/remote.wav");
        let existsRemote = true; try { await fs.promises.access(remoteFilesAbs); } catch { existsRemote = false; }
        assert.strictEqual(existsRemote, false, "pointer bytes should not be downloaded in stream-only");

        const localOnlyAbs = path.join(workspaceDir, ".project/attachments/files/audio/local-only.wav");
        const localBytes = await fs.promises.readFile(localOnlyAbs);
        assert.strictEqual(localBytes.toString(), "local-bytes", "local-only should be preserved");
    });
});
