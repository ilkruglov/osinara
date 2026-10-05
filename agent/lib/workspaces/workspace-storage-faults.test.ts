/**
 * Workspace storage under injected filesystem failures.
 *
 * Constructs covered:
 * - Every descriptor opened is closed when a later step fails: a failing stat of the opened
 *   file, a failing close of a parent directory on the walk (Codex review, 5 October 2026).
 * - A write that fails after the temporary file exists (ENOSPC) leaves no temporary file.
 * - A delete whose target became a directory after the check, and a nested write whose directory
 *   was removed on the way, fail with the workspace codes.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface Faults {
  closeDirectoryFails: boolean;
  mkdirCode: string | null;
  statFails: boolean;
  unlinkCode: string | null;
  writeFails: boolean;
}
const faults: Faults = { closeDirectoryFails: false, mkdirCode: null, statFails: false, unlinkCode: null, writeFails: false };
let opened = 0;
let closed = 0;

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
        return await stat(...statArgs);
      }) as typeof handle.stat;
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
  Object.assign(faults, { closeDirectoryFails: false, mkdirCode: null, statFails: false, unlinkCode: null, writeFails: false });
  opened = 0;
  closed = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("workspace storage under failures", () => {
  it("closes the opened file when its stat fails", async () => {
    const { root } = await workspace();
    faults.statFails = true;
    await expect(readWorkspaceFile(root, WORKSPACE_ID, "docs/file.txt")).rejects.toThrow("EIO");
    expect(closed).toBe(opened);
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
