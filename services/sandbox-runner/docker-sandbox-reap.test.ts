/**
 * Sandbox process-pressure reaping tests.
 *
 * Constructs covered:
 * - A running container whose leftover daemons reach half the pid budget is restarted before the
 *   requested operation runs, so the operation never meets EAGAIN inside the container.
 * - A container below the threshold is left alone.
 */
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";
import { SANDBOX_PIDS_REAP_THRESHOLD } from "./docker-sandbox-options.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function dockerWithProcesses(processes: number) {
  const container = {
    exec: vi.fn(async () => ({
      inspect: vi.fn(async () => ({ ExitCode: 0, Running: false })),
      start: vi.fn(async () => new PassThrough()),
    })),
    inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
    restart: vi.fn(async () => undefined),
    top: vi.fn(async () => ({ Processes: Array.from({ length: processes }, (_, index) => [String(index + 1)]) })),
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
    roots: { toolsRoot: "/tools", workspaceRoot: "/workspaces" },
    runtime: {
      egressNetwork: "osinara_sandbox-egress",
      image: "osinara-sandbox-runtime:local",
      project: "osinara",
      toolsVolume: "osinara_tool-environments",
      workspaceVolume: "osinara_workspace-data",
    },
  });
  return { container, engine };
}

describe("sandbox process reaping", () => {
  it("restarts a container crowded by leftover daemons before running the command", async () => {
    const { container, engine } = dockerWithProcesses(SANDBOX_PIDS_REAP_THRESHOLD);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await engine.runProcess(SANDBOX_SESSION_ID, { command: "true" });

    expect(result.exitCode).toBe(0);
    expect(container.top).toHaveBeenCalledWith({ ps_args: "-eo pid" });
    expect(container.restart).toHaveBeenCalledWith({ t: 0 });
    expect(container.restart.mock.invocationCallOrder[0]).toBeLessThan(
      container.exec.mock.invocationCallOrder[0]!,
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_SANDBOX_RUNNER_PROCESSES_REAPED"),
    );
    consoleError.mockRestore();
  });

  it("leaves a container below the threshold running as it is", async () => {
    const { container, engine } = dockerWithProcesses(SANDBOX_PIDS_REAP_THRESHOLD - 1);

    await engine.runProcess(SANDBOX_SESSION_ID, { command: "true" });

    expect(container.restart).not.toHaveBeenCalled();
  });
});
