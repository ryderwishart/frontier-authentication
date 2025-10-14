import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";
import { GitLabService } from "../../../gitlab/GitLabService";
import { SCMManager } from "../../../scm/SCMManager";
import { StateManager } from "../../../state";

suite("Integration: clone respects mediaStrategy", () => {
    let workspaceDir: string;
    let originalFetch: any;
    let originalClone: any;
    let originalGetRemoteUrl: any;

    suiteSetup(async () => {
        const ext = vscode.extensions.getExtension("frontier-rnd.frontier-authentication");
        assert.ok(ext, "Extension not found");
        await ext!.activate();

        // Patch GitLabService minimal auth
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
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-clone-ms-"));

        await git.init({ fs, dir: workspaceDir, defaultBranch: "main" });
        await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "hello", "utf8");
        await git.add({ fs, dir: workspaceDir, filepath: "README.md" });
        const headOid = await git.commit({
            fs,
            dir: workspaceDir,
            message: "initial",
            author: { name: "Tester", email: "tester@example.com" },
        });

        // Add a pointer under pointers dir
        const fakeOid = "c".repeat(64);
        const pointerRel = ".project/attachments/pointers/audio/clip.wav";
        const pointerAbs = path.join(workspaceDir, pointerRel);
        await fs.promises.mkdir(path.dirname(pointerAbs), { recursive: true });
        const pointerText = [
            "version https://git-lfs.github.com/spec/v1",
            `oid sha256:${fakeOid}`,
            "size 11",
        ].join("\n");
        await fs.promises.writeFile(pointerAbs, pointerText, "utf8");
        await git.add({ fs, dir: workspaceDir, filepath: pointerRel });
        const newHead = await git.commit({
            fs,
            dir: workspaceDir,
            message: "add pointer",
            author: { name: "Tester", email: "tester@example.com" },
        });

        // Simulate remote by setting origin and remote ref to HEAD
        const remoteUrl = "https://example.com/repo.git";
        await git.addRemote({ fs, dir: workspaceDir, remote: "origin", url: remoteUrl });
        await git.writeRef({ fs, dir: workspaceDir, ref: "refs/remotes/origin/main", value: newHead, force: true });

        // Stub git.clone to avoid network and skip actual clone since repo already present
        originalClone = (git as any).clone;
        (git as any).clone = async () => {};

        // Stub fetch to satisfy LFS batch/download for auto-download case
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
                return new Response(Buffer.from("hello-bytes"), { status: 200 });
            }

            return new Response("", { status: 200 });
        };

        // Initialize StateManager
        const fakeContext: any = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        StateManager.initialize(fakeContext);

        // Patch SCMManager workspace path getter to our target dir later when we simulate opening
        (SCMManager as any).prototype.getWorkspacePath = function () {
            return this.__testWorkspace || workspaceDir;
        };
        (SCMManager as any).prototype.registerCommands = function () {};

        // Ensure GitService.getRemoteUrl returns our origin URL to enable reconcile
        const { GitService } = require("../../../git/GitService");
        originalGetRemoteUrl = GitService.prototype.getRemoteUrl;
        GitService.prototype.getRemoteUrl = async function (_dir: string) {
            return remoteUrl;
        };
    });

    teardown(async () => {
        (globalThis as any).fetch = originalFetch;
        if (originalClone) (git as any).clone = originalClone;
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
        if (originalGetRemoteUrl) {
            const { GitService } = require("../../../git/GitService");
            GitService.prototype.getRemoteUrl = originalGetRemoteUrl;
        }
    });

    test("stream-only: clone skips bulk media downloads", async () => {
        // Arrange: create SCM with token
        const authProvider: any = {};
        const gl = new GitLabService(authProvider);
        const context: any = { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
        const scm = new SCMManager(gl, context) as any;

        // Act: call underlying gitService.clone directly
        await scm.gitService.clone("https://example.com/repo.git", workspaceDir, { username: "oauth2", password: "mock-token" }, "stream-only");

        // Assert: files bytes should NOT exist (no bulk download)
        const filesAbs = path.join(workspaceDir, ".project/attachments/files/audio/clip.wav");
        let exists = true;
        try { await fs.promises.access(filesAbs); } catch { exists = false; }
        assert.strictEqual(exists, false, "files/clip.wav should not be downloaded in stream-only");
    });

    test("auto-download: clone downloads media bytes", async () => {
        const authProvider: any = {};
        const gl = new GitLabService(authProvider);
        const context: any = { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
        const scm = new SCMManager(gl, context) as any;

        await scm.gitService.clone("https://example.com/repo.git", workspaceDir, { username: "oauth2", password: "mock-token" }, "auto-download");

        const filesAbs = path.join(workspaceDir, ".project/attachments/files/audio/clip.wav");
        const bytes = await fs.promises.readFile(filesAbs);
        assert.strictEqual(bytes.toString(), "hello-bytes");
    });
});
