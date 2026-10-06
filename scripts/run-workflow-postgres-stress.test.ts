/**
 * The Workflow stress runner refuses to start without the queue's internal token.
 *
 * Construct covered:
 * - Since the flow route is behind AGENT_INTERNAL_TOKEN, a stand without it would start Eve and
 *   then fail every delivery inside it; the runner names the missing variable before spawning
 *   anything (Codex review, 6 October 2026).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RUNNER = fileURLToPath(new URL("./run-workflow-postgres-stress.ts", import.meta.url));

describe("workflow stress runner", () => {
  it("names the missing internal token before starting the fixture", () => {
    const env = { ...process.env };
    delete env.AGENT_INTERNAL_TOKEN;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", RUNNER], { encoding: "utf8", env, timeout: 20_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_INTERNAL_TOKEN_MISSING");
    expect(result.stderr).not.toContain("AGENT_WORKFLOW_STRESS_FAILED");
  });
});
