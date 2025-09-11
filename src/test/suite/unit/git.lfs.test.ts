import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { GitService } from "../../../git/GitService";

suite("Git LFS - Empty Pointer Handling", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frontier-auth-lfs-"));
    let repoDir: string;

    // Minimal StateManager stub for GitService ctor
    const stateStub: any = {
        isSyncLocked: () => false,
        acquireSyncLock: async () => true,
        releaseSyncLock: async () => {},
    };

    const git = new GitService(stateStub);

    setup(async () => {
        repoDir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
        // Initialize repo and set remote
        await git.init(repoDir);
        await git.addRemote(repoDir, "origin", "https://example.com/repo.git");

        // Write .gitattributes marking pointers path as LFS-tracked
        const attrs = [".project/attachments/pointers/** filter=lfs"].join("\n");
        await fs.promises.writeFile(path.join(repoDir, ".gitattributes"), attrs, "utf8");

        // Create empty pointer file under pointers directory
        const pointerRel = ".project/attachments/pointers/audio/clip.wav";
        const pointerAbs = path.join(repoDir, pointerRel);
        await fs.promises.mkdir(path.dirname(pointerAbs), { recursive: true });
        await fs.promises.writeFile(pointerAbs, new Uint8Array());

        // Ensure corresponding files dir exists (no file written, so recovery cannot read real bytes)
        const filesDir = path.join(repoDir, ".project/attachments/files/audio");
        await fs.promises.mkdir(filesDir, { recursive: true });
    });

    teardown(async () => {
        // Cleanup repoDir
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
        } catch {}
    });

    test("addAllWithLFS skips empty pointer and moves it to corrupted without throwing", async () => {
        const pointerRel = ".project/attachments/pointers/audio/clip.wav";
        const pointerAbs = path.join(repoDir, pointerRel);

        // Sanity check
        assert.ok(fs.existsSync(pointerAbs), "Pointer file should exist before test");

        // Act: should not throw
        await assert.doesNotReject(async () => {
            await git.addAllWithLFS(repoDir, { username: "u", password: "p" });
        });

        // Assert: original pointer should be moved to files/corrupted/pointers
        const filesRoot = path.join(repoDir, ".project/attachments/files");
        const pointersRoot = path.join(repoDir, ".project/attachments/pointers");
        const relUnderPointers = path.relative(pointersRoot, pointerAbs);
        const corruptedPointerAbs = path.join(filesRoot, "corrupted", "pointers", relUnderPointers);

        assert.strictEqual(
            fs.existsSync(pointerAbs),
            false,
            "Empty pointer should be removed from pointers dir"
        );
        assert.strictEqual(
            fs.existsSync(corruptedPointerAbs),
            true,
            "Empty pointer should be recorded under files/corrupted/pointers"
        );
    });
});
