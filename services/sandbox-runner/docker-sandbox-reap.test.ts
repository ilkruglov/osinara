/**
 * Sandbox process-pressure reaping tests.
 *
 * Constructs covered:
 * - A running container whose leftover daemons' threads reach half the pid budget is restarted
 *   before the requested operation runs, so the operation never meets EAGAIN inside the container.
 * - A container below the threshold is left alone.
 * - The restart passes the capacity gate that every start passes: while the container is down
 *   for its restart, another session's start cannot take its slot (Codex review, 6 November 2026:
 *   with a cap of one, two containers ran).
 */
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";
import { sandboxContainerName } from "./docker-sandbox-lifecycle.js";
import { SANDBOX_PIDS_REAP_THRESHOLD } from "./docker-sandbox-options.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function dockerWithThreads(threads: number) {
  const container = {
    exec: vi.fn(async () => ({
      inspect: vi.fn(async () => ({ ExitCode: 0, Running: false })),
      start: vi.fn(async () => {
        const output = new PassThrough();
        output.end();
        return output;
      }),
    })),
    inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
    restart: vi.fn(async () => undefined),
    // One Chromium is a dozen processes carrying most of the threads; the cgroup counts threads.
    top: vi.fn(async () => ({
      Processes: [
        ["1", "1"],
        ["7", "1"],
        ["120", String(threads - 2)],
      ],
    })),
  };
  const docker = {
    getContainer: vi.fn(() => container),
    modem: {
      // Output ends when the exec stream ends, so a test can keep a command running.
      demuxStream: vi.fn((stream: PassThrough, stdout: PassThrough, stderr: PassThrough) => {
        stream.on("end", () => {
          stdout.end();
          stderr.end();
        });
        stream.resume();
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

const OTHER_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("sandbox process reaping", () => {
  it("restarts inside the capacity gate, so another session's start waits for it", async () => {
    let finishRestart!: () => void;
    const finished = () => {
      const output = new PassThrough();
      output.end();
      return output;
    };
    const exec = vi.fn(async () => ({
      inspect: vi.fn(async () => ({ ExitCode: 0, Running: false })),
      start: vi.fn(async () => finished()),
    }));
    const crowded = {
      exec,
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      restart: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRestart = resolve;
          }),
      ),
      top: vi.fn(async () => ({ Processes: [["1", String(SANDBOX_PIDS_REAP_THRESHOLD)]] })),
    };
    let otherRunning = false;
    const stopped = {
      exec,
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: otherRunning } })),
      start: vi.fn(async () => {
        otherRunning = true;
      }),
    };
    const docker = {
      getContainer: vi.fn((name: string) =>
        name === sandboxContainerName(OTHER_SESSION_ID) ? stopped : crowded,
      ),
      listContainers: vi.fn(async () => []),
      modem: {
        demuxStream: vi.fn((stream: PassThrough, stdout: PassThrough, stderr: PassThrough) => {
          stream.on("end", () => {
            stdout.end();
            stderr.end();
          });
          stream.resume();
        }),
      },
    } as unknown as Docker;
    const engine = createDockerSandboxEngine({
      docker,
      limits: { maxRunningContainers: 1 },
      roots: { toolsRoot: "/tools", workspaceRoot: "/workspaces" },
      runtime: {
        egressNetwork: "osinara_sandbox-egress",
        image: "osinara-sandbox-runtime:local",
        project: "osinara",
        toolsVolume: "osinara_tool-environments",
        workspaceVolume: "osinara_workspace-data",
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const reaped = engine.runProcess(SANDBOX_SESSION_ID, { command: "true" });
    await vi.waitFor(() => expect(crowded.restart).toHaveBeenCalled());
    const other = engine.runProcess(OTHER_SESSION_ID, { command: "true" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The crowded container is down for its restart: no start may count the room meanwhile.
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(stopped.start).not.toHaveBeenCalled();
    finishRestart();
    await reaped;
    await other;
    expect(stopped.start).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("restarts a container crowded by leftover daemons before running the command", async () => {
    const { container, engine } = dockerWithThreads(SANDBOX_PIDS_REAP_THRESHOLD);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await engine.runProcess(SANDBOX_SESSION_ID, { command: "true" });

    expect(result.exitCode).toBe(0);
    expect(container.top).toHaveBeenCalledWith({ ps_args: "-eo pid,nlwp" });
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
    const { container, engine } = dockerWithThreads(SANDBOX_PIDS_REAP_THRESHOLD - 1);

    await engine.runProcess(SANDBOX_SESSION_ID, { command: "true" });

    expect(container.restart).not.toHaveBeenCalled();
  });

  it("does not restart a crowded container while another command of the session is running", async () => {
    const { container, engine } = dockerWithThreads(SANDBOX_PIDS_REAP_THRESHOLD);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstOutput = new PassThrough();
    let started = 0;
    container.exec.mockImplementation(async () => ({
      inspect: vi.fn(async () => ({ ExitCode: 0, Running: false })),
      start: vi.fn(async () => {
        started += 1;
        if (started === 1) return firstOutput;
        const output = new PassThrough();
        output.end();
        return output;
      }),
    }));

    const first = engine.runProcess(SANDBOX_SESSION_ID, { command: "sleep 5" });
    await vi.waitFor(() => expect(started).toBe(1));
    container.restart.mockClear();
    // The second command arrives while the first still runs: a restart would kill the first.
    const second = await engine.runProcess(SANDBOX_SESSION_ID, { command: "true" });
    expect(second.exitCode).toBe(0);
    expect(container.restart).not.toHaveBeenCalled();
    firstOutput.end();
    await first;
    consoleError.mockRestore();
  });
});
