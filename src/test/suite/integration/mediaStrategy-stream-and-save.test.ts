import * as assert from "assert";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";
import { GitLabService } from "../../../gitlab/GitLabService";
import { SCMManager } from "../../../scm/SCMManager";
import { StateManager } from "../../../state";

suite("Integration: clone with stream-and-save does not bulk download", () => {
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
    });

    setup(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-clone-sas-"));
        await git.init({ fs, dir: workspaceDir, defaultBranch: "main" });

        const pointerRel = ".project/attachments/pointers/audio/on-demand.wav";
        const pointerAbs = path.join(workspaceDir, pointerRel);
        await fs.promises.mkdir(path.dirname(pointerAbs), { recursive: true });
        await fs.promises.writeFile(
            pointerAbs,
            [
                "version https://git-lfs.github.com/spec/v1",
                `oid sha256:${"e".repeat(64)}`,
                "size 5",
            ].join("\n"),
            "utf8"
        );
        await git.add({ fs, dir: workspaceDir, filepath: pointerRel });
        const head = await git.commit({ fs, dir: workspaceDir, message: "add ptr", author: { name: "T", email: "t@e" } });
        await git.addRemote({ fs, dir: workspaceDir, remote: "origin", url: "https://example.com/repo.git" });
        await git.writeRef({ fs, dir: workspaceDir, ref: "refs/remotes/origin/main", value: head, force: true });

        originalClone = (git as any).clone;
        (git as any).clone = async () => {};

        originalFetch = (globalThis as any).fetch;
        (globalThis as any).fetch = async (input: any, init?: any) => {
            const url = typeof input === "string" ? input : String(input);
            const method = init?.method || "GET";

            if (url.includes("/info/lfs/objects/batch") && method === "POST") {
                // Respond as usual but downloads shouldn't be triggered for stream-and-save during clone
                return new Response(JSON.stringify({ objects: [] }), {
                    status: 200,
                    headers: { "content-type": "application/vnd.git-lfs+json" },
                });
            }
            return new Response("", { status: 200 });
        };

        const fakeContext: any = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        StateManager.initialize(fakeContext);

        (SCMManager as any).prototype.getWorkspacePath = function () { return workspaceDir; };
        (SCMManager as any).prototype.registerCommands = function () {};

        const { GitService } = require("../../../git/GitService");
        const originalGetRemoteUrl = GitService.prototype.getRemoteUrl;
        GitService.prototype.getRemoteUrl = async () => "https://example.com/repo.git";
        // Restore in teardown
        (global as any).__restoreGetRemoteUrl = () => { GitService.prototype.getRemoteUrl = originalGetRemoteUrl; };
    });

    teardown(async () => {
        (globalThis as any).fetch = originalFetch;
        if (originalClone) (git as any).clone = originalClone;
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
        if ((global as any).__restoreGetRemoteUrl) { (global as any).__restoreGetRemoteUrl(); delete (global as any).__restoreGetRemoteUrl; }
    });

    test("stream-and-save: clone populates files with pointers", async () => {
        const gl = new GitLabService({} as any);
        const scm = new SCMManager(gl, { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } } as any) as any;

        await scm.gitService.clone("https://example.com/repo.git", workspaceDir, { username: "oauth2", password: "mock-token" }, "stream-and-save");

        // After clone with stream-and-save, files folder should have pointer file (not full media)
        const filesAbs = path.join(workspaceDir, ".project/attachments/files/audio/on-demand.wav");
        let exists = true; try { await fs.promises.access(filesAbs); } catch { exists = false; }
        assert.strictEqual(exists, true, "pointer file should be copied to files folder");

        // Verify it's a pointer file, not full media
        const content = await fs.promises.readFile(filesAbs, "utf8");
        assert.ok(content.includes("version https://git-lfs.github.com/spec/v1"), "should be a pointer file");
        assert.ok(content.length < 200, "pointer file should be small");
    });
});
