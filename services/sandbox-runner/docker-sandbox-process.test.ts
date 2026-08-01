/**
 * Docker sandbox process lifecycle regression tests.
 *
 * Constructs covered:
 * - Default command timeout and stable timeout diagnostics.
 * - Forced disposable-compute cleanup when Docker exec remains active.
 */
import { Readable } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const runtime = {
  googleWorkspaceCredentialsVolume: "osinara_google-workspace-credentials",
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};

function processHarness(inspection: { ExitCode: number | null; Running: boolean }) {
  const remove = vi.fn(async () => undefined);
  const exec = {
    inspect: vi.fn(async () => inspection),
    start: vi.fn(async () => Readable.from([])),
  };
  const container = {
    exec: vi.fn(async () => exec),
    inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
    remove,
  };
  const docker = {
    getContainer: vi.fn(() => container),
    modem: {
      demuxStream: vi.fn((_stream, stdout, stderr) => {
        stdout.end();
        stderr.end();
      }),
    },
  } as unknown as Docker;
  const engine = createDockerSandboxEngine({
    docker,
    roots: {
      googleWorkspaceCredentialsRoot: "/google-workspace-credentials",
      toolsRoot: "/tools",
      workspaceRoot: "/workspaces",
    },
    runtime,
  });
  return { container, engine, remove };
}

describe("Docker sandbox process lifecycle", () => {
  it("bounds commands by default and reports GNU timeout termination", async () => {
    const harness = processHarness({ ExitCode: 124, Running: false });

    await expect(harness.engine.runProcess(SANDBOX_SESSION_ID, { command: "sleep infinity" }))
      .resolves.toMatchObject({
        exitCode: 124,
        stderr: expect.stringContaining("AGENT_SANDBOX_RUNNER_PROCESS_TIMED_OUT"),
      });
    expect(harness.container.exec).toHaveBeenCalledWith(expect.objectContaining({
      Cmd: ["timeout", "--signal=TERM", "--kill-after=5s", "120", "bash", "-c", "sleep infinity"],
    }));
  });

  it("removes disposable compute when an aborted exec is still running", async () => {
    const harness = processHarness({ ExitCode: null, Running: true });

    await expect(harness.engine.runProcess(SANDBOX_SESSION_ID, { command: "stuck-command" }))
      .rejects.toThrowError(/AGENT_SANDBOX_RUNNER_PROCESS_STATE_INVALID/);
    expect(harness.remove).toHaveBeenCalledWith({ force: true, v: true });
  });
});
