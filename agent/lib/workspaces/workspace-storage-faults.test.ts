/**
 * Workspace storage under injected filesystem failures.
 *
 * Constructs covered:
 * - Every descriptor opened is closed when a later step fails: a failing stat of the opened
 *   file, a failing close of a parent directory on the walk (Codex review, 5 October 2026).
 * - A write that fails after the temporary file exists (ENOSPC) leaves no temporary file.
 * - A delete whose target became a directory after the check, and a nested write whose directory
 *   was removed on the way, fail with the workspace codes.
 * - A file the sandbox grows after the size check is refused without reading it whole: the read
 *   stops one byte past the limit (Codex review, 6 November 2026: `readFile` buffered whatever the
 *   file had grown to, up to a gigabyte, before the size check).
 */
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKSPACE_MAX_FILE_BYTES } from "../../config.js";

interface Faults {
  closeDirectoryFails: boolean;
  /** The size the file's stat reports: the sandbox grows the file right after it. */
  statReportsSize: number | null;
  mkdirCode: string | null;
  statFails: boolean;
  unlinkCode: string | null;
  writeFails: boolean;
}
const faults: Faults = { closeDirectoryFails: false, mkdirCode: null, statFails: false, statReportsSize: null, unlinkCode: null, writeFails: false };
let opened = 0;
let closed = 0;
let bytesRead = 0;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      opened += 1;
      const isDirectory = typeof args[1] === "number" && (args[1] & (await import("node:fs")).constants.O_DIRECTORY) !== 0;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closed += 1;
        await close();
        if (isDirectory && faults.closeDirectoryFails) throw Object.assign(new Error("EIO"), { code: "EIO" });
      };
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...statArgs: Parameters<typeof stat>) => {
        if (faults.statFails && !isDirectory) throw Object.assign(new Error("EIO"), { code: "EIO" });
        const metadata = await stat(...statArgs);
        if (faults.statReportsSize !== null && !isDirectory) Object.defineProperty(metadata, "size", { value: faults.statReportsSize });
        return metadata;
      }) as typeof handle.stat;
      const readWhole = handle.readFile.bind(handle);
      handle.readFile = (async (...readArgs: Parameters<typeof readWhole>) => {
        const content = await readWhole(...readArgs);
        bytesRead += typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
        return content;
      }) as typeof handle.readFile;
      const readPart = handle.read.bind(handle) as (...partArgs: unknown[]) => Promise<{ bytesRead: number }>;
      handle.read = (async (...partArgs: unknown[]) => {
        const result = await readPart(...partArgs);
        bytesRead += result.bytesRead;
        return result;
      }) as typeof handle.read;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = (async (...writeArgs: Parameters<typeof write>) => {
        if (faults.writeFails) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        return await write(...writeArgs);
      }) as typeof handle.writeFile;
      return handle;
    },
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      // Only the walk's own directory creation fails, as when the sandbox removes the parent.
      if (faults.mkdirCode && String(args[0]).startsWith("/proc/self/fd/")) {
        throw Object.assign(new Error(faults.mkdirCode), { code: faults.mkdirCode });
      }
      return await actual.mkdir(...args);
    },
    async unlink(path: Parameters<typeof actual.unlink>[0]) {
      if (faults.unlinkCode) throw Object.assign(new Error(faults.unlinkCode), { code: faults.unlinkCode });
      return await actual.unlink(path);
    },
  };
});

const { deleteWorkspaceFile, readWorkspaceFile, workspaceDirectory, writeWorkspaceFile } = await import("./workspace-storage.js");

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];

async function workspace(): Promise<{ directory: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "osinara-storage-faults-"));
  roots.push(root);
  const directory = workspaceDirectory(root, WORKSPACE_ID);
  await mkdir(join(directory, "docs"), { recursive: true });
  await writeFile(join(directory, "docs", "file.txt"), "inside");
  return { directory, root };
}

afterEach(async () => {
  Object.assign(faults, { closeDirectoryFails: false, mkdirCode: null, statFails: false, statReportsSize: null, unlinkCode: null, writeFails: false });
  opened = 0;
  closed = 0;
  bytesRead = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("workspace storage under failures", () => {
  it("closes the opened file when its stat fails", async () => {
    const { root } = await workspace();
    faults.statFails = true;
    await expect(readWorkspaceFile(root, WORKSPACE_ID, "docs/file.txt")).rejects.toThrow("EIO");
    expect(closed).toBe(opened);
  });

  it("refuses a file grown past the limit after its size check without reading it whole", async () => {
    const { directory, root } = await workspace();
    // Sparse: 200 MiB on disk costs nothing, read whole it is a 200 MiB buffer.
    await truncate(join(directory, "docs", "file.txt"), 200 * 1024 * 1024);
    faults.statReportsSize = 6;

    await expect(readWorkspaceFile(root, WORKSPACE_ID, "docs/file.txt")).rejects.toThrow("AGENT_WORKSPACE_FILE_TOO_LARGE");
    expect(bytesRead).toBe(WORKSPACE_MAX_FILE_BYTES + 1);
    expect(closed).toBe(opened);
  });

  it("reads a file of exactly the limit", async () => {
    const { directory, root } = await workspace();
    await truncate(join(directory, "docs", "file.txt"), WORKSPACE_MAX_FILE_BYTES);

    await expect(readWorkspaceFile(root, WORKSPACE_ID, "docs/file.txt")).resolves.toHaveLength(WORKSPACE_MAX_FILE_BYTES);
  });

  it("closes every handle on the walk when closing a parent directory fails", async () => {
    const { root } = await workspace();
    faults.closeDirectoryFails = true;
    await expect(readWorkspaceFile(root, WORKSPACE_ID, "docs/file.txt")).resolves.toEqual(Buffer.from("inside"));
    expect(closed).toBe(opened);
  });

  it("removes the temporary file when the write fails", async () => {
    const { directory, root } = await workspace();
    faults.writeFails = true;
    await expect(writeWorkspaceFile(root, WORKSPACE_ID, "docs/new.txt", Buffer.from("x"))).rejects.toThrow("ENOSPC");
    expect(await readdir(join(directory, "docs"))).toEqual(["file.txt"]);
    expect(closed).toBe(opened);
  });

  it("reports a directory removed during a nested write with the workspace code", async () => {
    const { root } = await workspace();
    faults.mkdirCode = "ENOENT";
    await expect(writeWorkspaceFile(root, WORKSPACE_ID, "docs/a/b/new.txt", Buffer.from("x")))
      .rejects.toThrow("AGENT_WORKSPACE_FILE_NOT_FOUND");
    expect(closed).toBe(opened);
  });

  it("refuses a delete whose target became a directory with the workspace code", async () => {
    const { root } = await workspace();
    faults.unlinkCode = "EISDIR";
    await expect(deleteWorkspaceFile(root, WORKSPACE_ID, "docs/file.txt")).rejects.toThrow("AGENT_WORKSPACE_PATH_INVALID");
    expect(closed).toBe(opened);
  });
});
