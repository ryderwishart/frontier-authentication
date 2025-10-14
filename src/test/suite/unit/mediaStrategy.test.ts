import * as assert from "assert";
import { SCMManager } from "../../../scm/SCMManager";
import { StateManager } from "../../../state";
import { GitLabService } from "../../../gitlab/GitLabService";

suite("Media strategy plumbing", () => {
    test("SCMManager stores per-repo strategy", async () => {
        const ctx: any = {
            subscriptions: [],
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
        };
        StateManager.initialize(ctx);
        const scm = new SCMManager(new GitLabService({} as any), ctx);
        const path = "/tmp/workspace-a";
        await (scm as any).stateManager.setRepoStrategy(path, "stream-only");
        const s = await (scm as any).stateManager.getRepoStrategy(path);
        assert.strictEqual(s, "stream-only");
    });
});
