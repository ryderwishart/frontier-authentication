import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";
import { GitService } from "../../../git/GitService";

suite("Git core actions", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-git-core-"));
    let repoDir: string;

    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const service = new GitService(stateStub);

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
    });

    teardown(async () => {
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    test("init sets up repo; hasGitRepository true after first commit", async () => {
        await service.init(repoDir);
        // Before any commit, HEAD may not resolve to an OID
        assert.strictEqual(await service.hasGitRepository(repoDir), false);
        // Make initial commit
        const fp = path.join(repoDir, "init.txt");
        await fs.promises.writeFile(fp, "hello", "utf8");
        await git.add({ fs, dir: repoDir, filepath: "init.txt" });
        await git.commit({
            fs,
            dir: repoDir,
            message: "init",
            author: { name: "T", email: "t@example.com" },
        });
        assert.strictEqual(await service.hasGitRepository(repoDir), true);
    });

    test("addRemote and getRemoteUrl return origin URL", async () => {
        await service.init(repoDir);
        const url = "https://example.com/sample.git";
        await service.addRemote(repoDir, "origin", url);
        const remoteUrl = await service.getRemoteUrl(repoDir);
        assert.strictEqual(remoteUrl, url);
    });

    test("addAll stages new and modified, remove handles deletions", async () => {
        await service.init(repoDir);
        // Create files
        const a = path.join(repoDir, "a.txt");
        const b = path.join(repoDir, "b.txt");
        await fs.promises.writeFile(a, "1", "utf8");
        await fs.promises.writeFile(b, "1", "utf8");
        // Stage both
        await service.addAll(repoDir);
        // Commit
        await git.commit({
            fs,
            dir: repoDir,
            message: "add a,b",
            author: { name: "T", email: "t@example.com" },
        });
        // Modify a and delete b
        await fs.promises.writeFile(a, "2", "utf8");
        await fs.promises.unlink(b);
        // addAll should stage modified and schedule deletion
        await service.addAll(repoDir);
        // Inspect index vs workdir using statusMatrix
        const status = await git.statusMatrix({ fs, dir: repoDir });
        // a.txt should have staged changes; b.txt should be removed
        const aEntry = status.find(([f]) => f === "a.txt");
        const bEntry = status.find(([f]) => f === "b.txt");
        assert.ok(aEntry, "a.txt should be tracked");
        assert.ok(bEntry, "b.txt should be tracked");
        // For b.txt, stage should indicate deletion (head=1, workdir=0)
        assert.strictEqual(bEntry?.[1], 1);
        assert.strictEqual(bEntry?.[2], 0);
    });

    test("push uses provided auth (no network)", async () => {
        await service.init(repoDir);
        const remote = "https://example.com/demo.git";
        await service.addRemote(repoDir, "origin", remote);
        // Prepare a commit so push is callable
        await fs.promises.writeFile(path.join(repoDir, "c.txt"), "x", "utf8");
        await git.add({ fs, dir: repoDir, filepath: "c.txt" });
        await git.commit({
            fs,
            dir: repoDir,
            message: "c",
            author: { name: "T", email: "t@example.com" },
        });

        // Stub isomorphic-git push to capture onAuth
        let onAuthCalled = false;
        const origPush = (git as any).push;
        (git as any).push = async (opts: any) => {
            if (typeof opts.onAuth === "function") {
                const creds = opts.onAuth();
                onAuthCalled = creds?.username === "oauth2" && !!creds?.password;
            }
            return {};
        };

        try {
            await service.push(repoDir, { username: "oauth2", password: "token" });
            assert.strictEqual(
                onAuthCalled,
                true,
                "onAuth should be called with provided credentials"
            );
        } finally {
            (git as any).push = origPush;
        }
    });
});
