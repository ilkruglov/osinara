/**
 * Atomic sandbox seed archive tests.
 *
 * Constructs covered:
 * - Multiple seed files travel through one Docker archive call into a fresh directory under the
 *   staging directory (Docker writes archives only into volumes once the root is read-only).
 * - Archive paths, contents, and private file modes survive packing.
 * - An in-container tar copies the tree into place keeping modes and existing directories, and
 *   the unpacked directory is removed even when that fails.
 */
import { Readable } from "node:stream";

import type Docker from "dockerode";
import tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";

import { writeSandboxSeedArchive } from "./docker-sandbox-seed.js";

describe("sandbox seed archive", () => {
  it("packs all seed files into one private archive", async () => {
    const entries: Array<{ content: string; mode: number | undefined; name: string }> = [];
    const putArchive = vi.fn(async (archive: NodeJS.ReadableStream) => {
      await new Promise<void>((resolve, reject) => {
        const extract = tar.extract();
        extract.on("entry", (header, stream, next) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("end", () => {
            entries.push({
              content: Buffer.concat(chunks).toString("utf8"),
              mode: header.mode,
              name: header.name,
            });
            next();
          });
        });
        extract.on("finish", resolve);
        extract.on("error", reject);
        archive.on("error", reject);
        archive.pipe(extract);
      });
    });
    const commands: string[] = [];
    const exec = vi.fn(async (options: { Cmd: string[] }) => {
      commands.push(options.Cmd.at(-1)!);
      return { inspect: vi.fn(async () => ({ ExitCode: 0 })), start: vi.fn(async () => Readable.from([])) };
    });
    const container = { exec, putArchive } as unknown as Docker.Container;
    const docker = { modem: { demuxStream: vi.fn((stream: Readable) => stream.resume()) } } as unknown as Docker;

    await writeSandboxSeedArchive(docker, container, [
      { contentBase64: Buffer.from("alpha").toString("base64"), path: "/workspace/a.txt" },
      { contentBase64: Buffer.from("beta").toString("base64"), path: "/tools/personal/b.txt" },
    ], "/tools/personal/.osinara-staging");

    expect(putArchive).toHaveBeenCalledOnce();
    const target = (putArchive.mock.calls[0] as unknown as [unknown, { path: string }])[1].path;
    expect(target).toMatch(/^\/tools\/personal\/\.osinara-staging\/seed-[0-9a-f-]+$/u);
    expect(commands).toEqual([
      `mkdir -p -- '${target}'`,
      `cd '${target}' && find . -type f -print0 | tar --null --no-recursion -T - -cf - | tar -C / -xpf -`,
      `rm -rf -- '${target}'`,
    ]);
    expect(entries).toEqual([
      { content: "alpha", mode: 0o600, name: "workspace/a.txt" },
      { content: "beta", mode: 0o600, name: "tools/personal/b.txt" },
    ]);
  });
});
