/**
 * Docker sandbox filesystem bridge tests.
 *
 * Constructs covered:
 * - Reads come through the stdout of a process in the container and writes go in on its stdin,
 *   renamed into place there: Docker's archive API is never used (it reaches neither the
 *   read-only root nor a tmpfs HOME) and nothing is staged where the model could swap it.
 * - A missing file reads as null; a directory destination fails with the commit code; a file
 *   above the workspace limit is refused before any process starts; a stream that closes without
 *   ending does not hang the transfer.
 * - A skill package identical to the one already in this container run costs no Docker work.
 * - A restarted container and every workspace file are written again regardless.
 */
import { Duplex } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";

const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtime = {
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};

interface ExecCall { cmd: string[]; stdin: Buffer }
type Reply = { exitCode: number; stdout?: Buffer };

/** A running container whose processes answer `reply(cmd)` and record their stdin. */
function containerAnswering(reply: (cmd: string[]) => Reply, startedAt = "2026-09-10T10:00:00Z") {
  const calls: ExecCall[] = [];
  const container = {
    exec: vi.fn(async (options: { Cmd: string[] }) => {
      const call: ExecCall = { cmd: options.Cmd, stdin: Buffer.alloc(0) };
      calls.push(call);
      const answer = reply(options.Cmd);
      const chunks: Buffer[] = [];
      const stream = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
        final(done) {
          call.stdin = Buffer.concat(chunks);
          done();
        },
      });
      return {
        inspect: vi.fn(async () => ({ ExitCode: answer.exitCode, Running: false })),
        start: vi.fn(async (startOptions: { stdin?: boolean }) => {
          // Without stdin the process answers at once; with it, once the input is closed.
          const respond = () => {
            if (answer.stdout) stream.push(answer.stdout);
            stream.push(null);
          };
          if (startOptions.stdin) stream.once("finish", respond);
          else setImmediate(respond);
          return stream;
        }),
      };
    }),
    getArchive: vi.fn(),
    inspect: vi.fn(async () => ({
      Config: { Labels: {} },
      HostConfig: { Mounts: [{ Target: "/tools/personal" }] },
      Id: "container-1",
      State: { Running: true, StartedAt: startedAt },
    })),
    putArchive: vi.fn(),
    top: vi.fn(async () => ({ Processes: [] })),
  };
  return { calls, container };
}

function engineFor(container: unknown) {
  const docker = {
    getContainer: vi.fn(() => container),
    listContainers: vi.fn(async () => []),
    modem: { demuxStream: vi.fn((stream: Duplex, stdout: NodeJS.WritableStream) => stream.on("data", (chunk) => stdout.write(chunk))) },
  } as unknown as Docker;
  return createDockerSandboxEngine({ docker, roots: { toolsRoot: "/tools", workspaceRoot: "/workspaces" }, runtime });
}

describe("Docker sandbox filesystem bridge", () => {
  it("reads a file through the stdout of a process in the container", async () => {
    const { calls, container } = containerAnswering(() => ({ exitCode: 0, stdout: Buffer.from("hello") }));
    const engine = engineFor(container);

    await expect(engine.readFile(SANDBOX_SESSION_ID, "/tmp/home/report.md")).resolves.toEqual(new Uint8Array(Buffer.from("hello")));
    expect(calls[0]!.cmd.slice(-2)).toEqual(["osinara-read", "/tmp/home/report.md"]);
    expect(container.getArchive).not.toHaveBeenCalled();
  });

  it("reads a missing file as null", async () => {
    const { container } = containerAnswering(() => ({ exitCode: 44 }));
    await expect(engineFor(container).readFile(SANDBOX_SESSION_ID, "/workspace/personal/none")).resolves.toBeNull();
  });

  it("writes a file on the stdin of a process that renames it into place", async () => {
    const { calls, container } = containerAnswering(() => ({ exitCode: 0 }));
    await engineFor(container).writeFile(SANDBOX_SESSION_ID, "/tmp/home/.agents/skills/a/SKILL.md", Buffer.from("skill"));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd.slice(-2)).toEqual(["osinara-write", "/tmp/home/.agents/skills/a/SKILL.md"]);
    expect(calls[0]!.cmd.join(" ")).toContain("mv -T");
    expect(calls[0]!.stdin.toString()).toBe("skill");
    expect(container.putArchive).not.toHaveBeenCalled();
  });

  it("fails a write onto a directory with the commit code", async () => {
    const { container } = containerAnswering(() => ({ exitCode: 1 }));
    await expect(engineFor(container).writeFile(SANDBOX_SESSION_ID, "/workspace/personal/dir", Buffer.from("x")))
      .rejects.toThrow("AGENT_SANDBOX_RUNNER_FILE_COMMIT_FAILED");
  });

  it("writes an unchanged skill package once per container run, again after a restart", async () => {
    const { calls, container } = containerAnswering(() => ({ exitCode: 0 }));
    const engine = engineFor(container);
    const path = "/tmp/home/.agents/skills/a/SKILL.md";
    await engine.writeFile(SANDBOX_SESSION_ID, path, Buffer.from("same"));
    await engine.writeFile(SANDBOX_SESSION_ID, path, Buffer.from("same"));
    expect(calls).toHaveLength(1);

    // Restricted HOME is a tmpfs, so a restart leaves the container without any skill package.
    container.inspect.mockResolvedValue({
      Config: { Labels: {} },
      HostConfig: { Mounts: [{ Target: "/tools/personal" }] },
      Id: "container-1",
      State: { Running: true, StartedAt: "2026-09-10T11:30:00Z" },
    });
    await engine.writeFile(SANDBOX_SESSION_ID, path, Buffer.from("same"));
    expect(calls).toHaveLength(2);
  });

  it("refuses a file above the workspace limit before starting a process", async () => {
    const { calls, container } = containerAnswering(() => ({ exitCode: 0 }));
    await expect(engineFor(container).writeFile(SANDBOX_SESSION_ID, "/workspace/personal/big.bin", Buffer.alloc(50 * 1024 * 1024 + 1)))
      .rejects.toThrow("AGENT_SANDBOX_RUNNER_FILE_TOO_LARGE");
    expect(calls).toHaveLength(0);
  });

  it("finishes a read whose stream closes without ending", async () => {
    const { container } = containerAnswering(() => ({ exitCode: 0 }));
    container.exec.mockImplementationOnce(async () => {
      const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
      return {
        inspect: vi.fn(async () => ({ ExitCode: 0, Running: false })),
        start: vi.fn(async () => {
          setImmediate(() => stream.destroy());
          return stream;
        }),
      };
    });
    await expect(engineFor(container).readFile(SANDBOX_SESSION_ID, "/workspace/personal/a.txt")).resolves.toEqual(new Uint8Array());
  });

  it("writes an identical workspace file again, because nothing else restores it", async () => {
    const { calls, container } = containerAnswering(() => ({ exitCode: 0 }));
    const engine = engineFor(container);
    await engine.writeFile(SANDBOX_SESSION_ID, "/workspace/personal/report.md", Buffer.from("same"));
    await engine.writeFile(SANDBOX_SESSION_ID, "/workspace/personal/report.md", Buffer.from("same"));
    expect(calls).toHaveLength(2);
  });
});
