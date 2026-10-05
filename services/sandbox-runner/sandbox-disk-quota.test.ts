/**
 * Disk budget of sandbox workspaces.
 *
 * Constructs covered:
 * - Past the 2 GiB budget of a workspace, or below 3 GiB free on the host, a write is refused
 *   with a code and a way out; under both it passes.
 * - Usage is measured at most once a minute per workspace, and concurrent checks share one
 *   measurement.
 * - Only plain one-line inspection and deletion commands pass a refusal (no newline, no find
 *   action that writes or runs), and they run with the system PATH.
 * - A failed measurement refuses and is not cached; the probe errors instead of summing partly.
 * - The host probe sums `du` over the directories that exist.
 * - The engine refuses the model's Bash with exit 125 and the reason, still runs a cleanup
 *   command, refuses a file write into /workspace, and measures the session's workspace, tool
 *   environment and browser state together.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Readable } from "node:stream";

import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";

import {
  createHostDiskProbe,
  createSandboxDiskQuota,
  isCleanupCommand,
  SANDBOX_MIN_FREE_BYTES,
  SANDBOX_WORKSPACE_QUOTA_BYTES,
} from "./sandbox-disk-quota.js";

const GIB = 1024 ** 3;
const workspace = { directories: ["/w/a", "/t/a"], key: "a" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("createSandboxDiskQuota", () => {
  it("refuses past the workspace budget or below the host's free floor", async () => {
    const probe = { freeBytes: vi.fn(async () => 10 * GIB), usedBytes: vi.fn(async () => SANDBOX_WORKSPACE_QUOTA_BYTES + 1) };
    const quota = createSandboxDiskQuota({ now: () => 0, probe });
    await expect(quota.refusal([workspace])).resolves.toMatch(/^AGENT_SANDBOX_WORKSPACE_QUOTA_EXCEEDED: .*rm/u);

    probe.usedBytes.mockResolvedValue(GIB);
    const fresh = createSandboxDiskQuota({ now: () => 0, probe });
    await expect(fresh.refusal([workspace])).resolves.toBeNull();

    probe.freeBytes.mockResolvedValue(SANDBOX_MIN_FREE_BYTES - 1);
    await expect(fresh.refusal([workspace])).resolves.toMatch(/^AGENT_SANDBOX_DISK_LOW: /u);
  });

  it("refuses when the measurement fails and measures again next time", async () => {
    const probe = {
      freeBytes: vi.fn(async () => 10 * GIB),
      usedBytes: vi.fn().mockRejectedValueOnce(new Error("du timed out")).mockResolvedValue(GIB),
    };
    const quota = createSandboxDiskQuota({ now: () => 0, probe });
    await expect(quota.refusal([workspace])).resolves.toMatch(/^AGENT_SANDBOX_DISK_UNMEASURED: /u);
    await expect(quota.refusal([workspace])).resolves.toBeNull();
  });

  it("measures a workspace at most once a minute and shares a running measurement", async () => {
    let now = 0;
    const probe = { freeBytes: vi.fn(async () => 10 * GIB), usedBytes: vi.fn(async () => GIB) };
    const quota = createSandboxDiskQuota({ now: () => now, probe });

    await Promise.all([quota.refusal([workspace]), quota.refusal([workspace])]);
    now = 59_000;
    await quota.refusal([workspace]);
    expect(probe.usedBytes).toHaveBeenCalledTimes(1);
    now = 61_000;
    await quota.refusal([workspace]);
    expect(probe.usedBytes).toHaveBeenCalledTimes(2);
  });
});

describe("isCleanupCommand", () => {
  it.each(["rm -rf /workspace/personal/big", "ls -la /workspace", "du -sh /workspace/* /tools/*", "find /workspace -name '*.tmp' -delete", "df -h"])(
    "lets %s pass a refusal",
    (command) => expect(isCleanupCommand(command)).toBe(true),
  );

  it.each([
    "rm x; dd if=/dev/zero of=y", "ls > list.txt", "rm $(cat list)", "rmx", "python3 clean.py",
    "find / -exec sh {} \\;", "rm\nprintf CLEANUP_BYPASS", "find /workspace -fprint /workspace/big",
    "find /workspace -fprintf /workspace/x %p", "find . -execdir sh {} +", "rm a\\\nb",
  ])(
    "refuses %s",
    (command) => expect(isCleanupCommand(command)).toBe(false),
  );
});

describe("createHostDiskProbe", () => {
  it("sums allocated bytes of the directories that exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-quota-"));
    roots.push(root);
    await mkdir(join(root, "a"));
    await writeFile(join(root, "a", "file"), Buffer.alloc(64 * 1024, 1));
    const probe = createHostDiskProbe(root);

    const used = await probe.usedBytes([join(root, "a"), join(root, "missing")]);
    expect(used).toBeGreaterThanOrEqual(64 * 1024);
    expect(await probe.freeBytes()).toBeGreaterThan(0);
  });
});

describe("disk budget in the engine", () => {
  const PERSONAL = "11111111-1111-4111-8111-111111111111";
  const runtime = {
    egressNetwork: "net",
    image: "image",
    project: "osinara",
    toolsVolume: "tools",
    workspaceVolume: "workspace",
  };
  const exec = vi.fn(async () => ({
    inspect: vi.fn(async () => ({ ExitCode: 0 })),
    start: vi.fn(async () => Readable.from([])),
  }));
  const docker = {
    getContainer: vi.fn(() => ({
      exec,
      inspect: vi.fn(async () => ({
        Config: { Labels: {} },
        HostConfig: {
          Mounts: [
            { Target: "/workspace/personal", VolumeOptions: { Subpath: PERSONAL } },
            { Target: "/tools/personal", VolumeOptions: { Subpath: PERSONAL } },
          ],
        },
        Id: "session",
        State: { Running: true, StartedAt: "2026-10-05T00:00:00Z" },
      })),
      top: vi.fn(async () => ({ Processes: [] })),
    })),
    listContainers: vi.fn(async () => []),
    modem: { demuxStream: vi.fn((stream: Readable) => stream.resume()) },
  } as unknown as Docker;

  it("refuses Bash and workspace writes past the budget and still runs cleanup", async () => {
    const usedBytes = vi.fn(async () => SANDBOX_WORKSPACE_QUOTA_BYTES + 1);
    const engine = createDockerSandboxEngine({
      diskQuota: createSandboxDiskQuota({ now: () => 0, probe: { freeBytes: async () => 10 * GIB, usedBytes } }),
      docker,
      roots: { toolsRoot: "/tools-root", workspaceRoot: "/workspace-root" },
      runtime,
    });

    const refused = await engine.runProcess("session", { command: "dd if=/dev/zero of=big bs=1M count=100" });
    expect(refused).toMatchObject({ exitCode: 125, stderr: expect.stringMatching(/^AGENT_SANDBOX_WORKSPACE_QUOTA_EXCEEDED/u) });
    expect(exec).not.toHaveBeenCalled();
    expect(usedBytes).toHaveBeenCalledWith([
      `/workspace-root/${PERSONAL}`,
      `/tools-root/${PERSONAL}`,
      `/tools-root/browser/${PERSONAL}`,
    ]);

    await expect(engine.runProcess("session", { command: "rm -rf /workspace/personal/big" })).resolves.toMatchObject({ exitCode: 0 });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(exec.mock.calls[0])).toContain("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");

    // Every file the model writes counts, not only /workspace.
    await expect(engine.writeFile("session", "/tools/personal/big.bin", Buffer.from("x")))
      .rejects.toThrow("AGENT_SANDBOX_WORKSPACE_QUOTA_EXCEEDED");

    await expect(engine.writeFile("session", "/workspace/personal/new.txt", Buffer.from("x")))
      .rejects.toThrow("AGENT_SANDBOX_WORKSPACE_QUOTA_EXCEEDED");
  });
});
