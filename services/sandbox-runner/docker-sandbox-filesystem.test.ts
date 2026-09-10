/**
 * Docker sandbox filesystem bridge tests.
 *
 * Constructs covered:
 * - Reads stage files outside tmpfs before using Docker's archive API.
 * - Writes stage archives outside tmpfs before moving files in-container.
 * - A skill package identical to the one already in this container run costs no Docker work.
 * - A restarted container and every workspace file are written again regardless.
 * - Failed file commits retain the original error and observe cleanup failures.
 */
import { PassThrough } from "node:stream";

import type Docker from "dockerode";
import tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type ExecOptions = { Cmd: string[] };

const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};

function successfulExec(source = new PassThrough()) {
  return {
    inspect: vi.fn(async () => ({ ExitCode: 0, Running: false })),
    start: vi.fn(async () => source),
  };
}

function createEngine(docker: Docker) {
  return createDockerSandboxEngine({
    docker,
    roots: {
      toolsRoot: "/tools",
      workspaceRoot: "/workspaces",
    },
    runtime,
  });
}

function runningContainer(id: string, startedAt: string) {
  return {
    exec: vi.fn(async (_options: ExecOptions) => successfulExec()),
    inspect: vi.fn(async () => ({
      Config: { Labels: {} },
      Id: id,
      State: { Running: true, StartedAt: startedAt },
    })),
    top: vi.fn(async () => ({ Processes: [] })),
    putArchive: vi.fn(async () => undefined),
  };
}

function dockerFor(container: unknown): Docker {
  return {
    getContainer: vi.fn(() => container),
    modem: {
      demuxStream: vi.fn((_stream: unknown, stdout: { end: () => void }, stderr: { end: () => void }) => {
        stdout.end();
        stderr.end();
      }),
    },
  } as unknown as Docker;
}

function archiveFile(name: string, content: string): NodeJS.ReadableStream {
  const pack = tar.pack();
  pack.entry({ name, type: "file" }, content);
  pack.finalize();
  return pack;
}

describe("Docker sandbox filesystem bridge", () => {
  it("stages a hidden-home read outside tmpfs before using the archive API", async () => {
    const container = {
      exec: vi.fn(async (_options: ExecOptions) => successfulExec()),
      getArchive: vi.fn(async () => archiveFile("staged", "skill instructions")),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      top: vi.fn(async () => ({ Processes: [] })),
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

    const content = await createEngine(docker).readFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/pohuy/SKILL.md",
    );

    expect(content).not.toBeNull();
    expect(new TextDecoder().decode(content!)).toBe("skill instructions");
    expect(container.getArchive).toHaveBeenCalledWith({
      path: expect.stringMatching(/^\/\.osinara-sandbox-uploads\//u),
    });
    const commands = container.exec.mock.calls.map(([options]) => options.Cmd.at(-1));
    expect(commands).toEqual([
      expect.stringMatching(/^mkdir -p -- .* && .*cp -T -- .*SKILL\.md/u),
      expect.stringMatching(/^rm -f -- /u),
    ]);
  });

  it("returns absence without invoking the archive API for a missing file", async () => {
    const missingExec = successfulExec();
    missingExec.inspect.mockResolvedValue({ ExitCode: 44, Running: false });
    const container = {
      exec: vi.fn(async () => missingExec),
      getArchive: vi.fn(),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      top: vi.fn(async () => ({ Processes: [] })),
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

    await expect(createEngine(docker).readFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/missing/SKILL.md",
    )).resolves.toBeNull();
    expect(container.getArchive).not.toHaveBeenCalled();
  });

  it("stages a hidden-home write outside tmpfs before moving it in-container", async () => {
    const source = new PassThrough();
    const exec = successfulExec(source);
    const container = {
      exec: vi.fn(async (_options: ExecOptions) => exec),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      top: vi.fn(async () => ({ Processes: [] })),
      putArchive: vi.fn(async () => undefined),
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

    await createEngine(docker).writeFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/pohuy/LICENSE.txt",
      new TextEncoder().encode("MIT"),
    );

    expect(container.putArchive).toHaveBeenCalledWith(
      expect.anything(),
      { path: "/.osinara-sandbox-uploads" },
    );
    const commands = container.exec.mock.calls.map(([options]) => options.Cmd.at(-1));
    expect(commands).toEqual([
      expect.stringMatching(/^mkdir -p -- .*\.osinara-sandbox-uploads/u),
      expect.stringMatching(
        /^mkdir -p -- '.*skills\/pohuy' && mv -T -- .* '.*\/tmp\/home\/\.agents\/skills\/pohuy\/LICENSE\.txt'$/u,
      ),
    ]);
  });

  // Eve rewrites every dynamic skill package on every turn; in an external group that was eleven
  // files and 2-5 seconds before the model saw the message (10 сентября 2026).
  it("writes an unchanged skill package once per container run", async () => {
    const container = runningContainer("container-1", "2026-09-10T10:00:00Z");
    const docker = dockerFor(container);
    const engine = createEngine(docker);
    const path = "/tmp/home/.agents/skills/auto-analyst/SKILL.md";
    const content = new TextEncoder().encode("---\nname: auto-analyst\n---\n");

    await engine.writeFile(SANDBOX_SESSION_ID, path, content);
    const execAfterFirst = container.exec.mock.calls.length;
    await engine.writeFile(SANDBOX_SESSION_ID, path, content);

    expect(container.putArchive).toHaveBeenCalledTimes(1);
    expect(container.exec.mock.calls.length).toBe(execAfterFirst);
    // Changed bytes are a different package and always reach the container.
    await engine.writeFile(SANDBOX_SESSION_ID, path, new TextEncoder().encode("v2"));
    expect(container.putArchive).toHaveBeenCalledTimes(2);
  });

  it("re-materializes the skill package after the container restarted", async () => {
    const container = runningContainer("container-1", "2026-09-10T10:00:00Z");
    const docker = dockerFor(container);
    const engine = createEngine(docker);
    const path = "/tmp/home/.agents/skills/auto-analyst/SKILL.md";
    const content = new TextEncoder().encode("skill");

    await engine.writeFile(SANDBOX_SESSION_ID, path, content);
    // Restricted HOME is a tmpfs, so a restart leaves the container without any skill package.
    container.inspect.mockResolvedValue({
      Config: { Labels: {} },
      Id: "container-1",
      State: { Running: true, StartedAt: "2026-09-10T11:30:00Z" },
    });
    await engine.writeFile(SANDBOX_SESSION_ID, path, content);

    expect(container.putArchive).toHaveBeenCalledTimes(2);
  });

  it("writes an identical workspace file again, because nothing else restores it", async () => {
    const container = runningContainer("container-1", "2026-09-10T10:00:00Z");
    const docker = dockerFor(container);
    const engine = createEngine(docker);
    const content = new TextEncoder().encode("report");

    await engine.writeFile(SANDBOX_SESSION_ID, "/workspace/group/report.md", content);
    await engine.writeFile(SANDBOX_SESSION_ID, "/workspace/group/report.md", content);

    expect(container.putArchive).toHaveBeenCalledTimes(2);
  });

  it("rejects a directory destination and observes failed staging cleanup", async () => {
    const exitCodes = [0, 1, 1];
    const container = {
      exec: vi.fn(async (_options: ExecOptions) => {
        const source = new PassThrough();
        const exitCode = exitCodes.shift();
        return {
          inspect: vi.fn(async () => ({ ExitCode: exitCode, Running: false })),
          start: vi.fn(async () => source),
        };
      }),
      inspect: vi.fn(async () => ({ Config: { Labels: {} }, State: { Running: true } })),
      top: vi.fn(async () => ({ Processes: [] })),
      putArchive: vi.fn(async () => undefined),
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
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(createEngine(docker).writeFile(
      SANDBOX_SESSION_ID,
      "/tmp/home/.agents/skills/pohuy",
      new TextEncoder().encode("must-not-land-inside-directory"),
    )).rejects.toThrowError(
      /AGENT_SANDBOX_RUNNER_FILE_COMMIT_FAILED: Не удалось записать файл/u,
    );
    const commands = container.exec.mock.calls.map(([options]) => options.Cmd.at(-1));
    expect(commands[1]).toMatch(/^mkdir -p -- .* && mv -T -- /u);
    expect(commands[2]).toMatch(/^rm -f -- /u);
    expect(consoleError).toHaveBeenCalledWith(
      "Sandbox staged file cleanup failed",
      expect.objectContaining({ exitCode: 1 }),
    );
    consoleError.mockRestore();
  });
});
