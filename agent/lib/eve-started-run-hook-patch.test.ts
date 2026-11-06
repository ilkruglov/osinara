/**
 * Eve waits for the hook of a session run it started while the run is alive (vendored Eve,
 * `execution/workflow-runtime.js`; logic in `scripts/eve-runtime/started-run-hook.ts`).
 *
 * Construct covered:
 * - Both waits after the start (the continuation token's owner and the session's command hook)
 *   go through `waitForStartedRunHook` with the run's own status, so a lagging queue no longer
 *   turns a delivered message into `HookNotFoundError` (Codex review, 6 November 2026).
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { codeText } from "./vendored-code.js";

describe("Eve started run hook wait", () => {
  it("waits for both hooks of a started run through the live-run wait", async () => {
    const code = codeText(await readFile(new URL("../../vendor/eve/dist/src/execution/workflow-runtime.js", import.meta.url), "utf8"));

    expect(code).toContain(codeText('import { waitForStartedRunHook } from "./osinara-started-run-hook.js";'));
    expect(code).toContain(codeText("let e = await waitStarted(() => waitForCommandHookOwner(i.continuationToken));"));
    expect(code).toContain(codeText("await waitStarted(() => waitForOwnedCommandHook(sessionCommandHookToken(p.runId), p.runId));"));
    expect(code).toContain(codeText("runStatus: () => getRun(p.runId).status,"));
  });
});
