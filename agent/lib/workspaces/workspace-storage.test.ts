/**
 * Confined workspace filesystem boundary tests.
 *
 * Constructs covered:
 * - Directly created nested files are immediately discoverable and readable.
 * - One Telegram inbox directory can be listed without scanning unrelated workspace files.
 * - Symlinks cannot be followed by trusted application file operations.
 * - A sandbox that swaps a file or a parent directory for a symlink while the agent reads,
 *   writes, lists or deletes cannot make the agent reach outside the workspace (security
 *   review, 5 October 2026: the checked path was used after the check).
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import {
  deleteWorkspaceFile,
  getWorkspaceStoredFile,
  listWorkspaceStoredFiles,
  listWorkspaceStoredFilesUnder,
  readWorkspaceFile,
  workspaceDirectory,
  writeWorkspaceFile,
} from "./workspace-storage.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("workspace storage", () => {
  it("uses files created directly in the mounted workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    const directory = workspaceDirectory(root, WORKSPACE_ID);
    await mkdir(join(directory, "output"), { recursive: true });
    await writeFile(join(directory, "output", "report.txt"), "готово");

    await expect(listWorkspaceStoredFiles(root, WORKSPACE_ID)).resolves.toEqual([
      expect.objectContaining({ path: "output/report.txt" }),
    ]);
    await expect(readWorkspaceFile(root, WORKSPACE_ID, "output/report.txt"))
      .resolves.toEqual(Buffer.from("готово"));
  });

  it("rejects a symlink instead of resolving it outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    const directory = workspaceDirectory(root, WORKSPACE_ID);
    await mkdir(directory, { recursive: true });
    await symlink("/etc/passwd", join(directory, "secret.txt"));

    await expect(readWorkspaceFile(root, WORKSPACE_ID, "secret.txt"))
      .rejects.toThrowError(/AGENT_WORKSPACE_SYMLINK_FORBIDDEN/);
  });

  it("lists only files under one Telegram inbox directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    const directory = workspaceDirectory(root, WORKSPACE_ID);
    await mkdir(join(directory, "inbox", "773"), { recursive: true });
    await mkdir(join(directory, "inbox", "775"), { recursive: true });
    await writeFile(join(directory, "inbox", "773", "image.jpg"), "image");
    await writeFile(join(directory, "inbox", "775", "other.jpg"), "other");

    await expect(listWorkspaceStoredFilesUnder(root, WORKSPACE_ID, "inbox/773"))
      .resolves.toEqual([expect.objectContaining({ path: "inbox/773/image.jpg" })]);
  });

  it("writes and deletes a nested file and reports its metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    await mkdir(workspaceDirectory(root, WORKSPACE_ID), { recursive: true });

    await writeWorkspaceFile(root, WORKSPACE_ID, "output/deep/report.txt", Buffer.from("v1"));
    await writeWorkspaceFile(root, WORKSPACE_ID, "output/deep/report.txt", Buffer.from("v22"));
    await expect(readWorkspaceFile(root, WORKSPACE_ID, "output/deep/report.txt")).resolves.toEqual(Buffer.from("v22"));
    await expect(getWorkspaceStoredFile(root, WORKSPACE_ID, "output/deep/report.txt"))
      .resolves.toMatchObject({ byteSize: 3, path: "output/deep/report.txt" });
    await expect(listWorkspaceStoredFiles(root, WORKSPACE_ID)).resolves.toEqual([
      expect.objectContaining({ path: "output/deep/report.txt" }),
    ]);
    await expect(deleteWorkspaceFile(root, WORKSPACE_ID, "output/deep/report.txt")).resolves.toBe(true);
    await expect(deleteWorkspaceFile(root, WORKSPACE_ID, "output/deep/report.txt")).resolves.toBe(false);
    await expect(readWorkspaceFile(root, WORKSPACE_ID, "output/deep/report.txt"))
      .rejects.toThrowError(/AGENT_WORKSPACE_FILE_NOT_FOUND/);
  });

  it("rejects a symlinked directory and a path through a regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    const directory = workspaceDirectory(root, WORKSPACE_ID);
    await mkdir(directory, { recursive: true });
    await symlink("/etc", join(directory, "etc"));
    await writeFile(join(directory, "plain.txt"), "x");

    await expect(readWorkspaceFile(root, WORKSPACE_ID, "etc/hostname")).rejects.toThrowError(/AGENT_WORKSPACE_SYMLINK_FORBIDDEN/);
    await expect(writeWorkspaceFile(root, WORKSPACE_ID, "etc/evil.txt", Buffer.from("x")))
      .rejects.toThrowError(/AGENT_WORKSPACE_SYMLINK_FORBIDDEN/);
    await expect(listWorkspaceStoredFilesUnder(root, WORKSPACE_ID, "etc")).rejects.toThrowError(/AGENT_WORKSPACE_SYMLINK_FORBIDDEN/);
    await expect(readWorkspaceFile(root, WORKSPACE_ID, "plain.txt/x")).rejects.toThrowError(/AGENT_WORKSPACE_PATH_INVALID/);
  });

  it("never reaches outside the workspace while a sandbox swaps paths for symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "osinara-storage-"));
    roots.push(root);
    const directory = workspaceDirectory(root, WORKSPACE_ID);
    const outside = join(root, "outside");
    await mkdir(join(directory, "docs"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "file.txt"), "OUTSIDE_WORKSPACE_SENTINEL");
    await writeFile(join(outside, "secret.txt"), "OUTSIDE_WORKSPACE_SENTINEL");
    await writeFile(join(directory, "file.txt"), "inside");
    await writeFile(join(directory, "docs", "file.txt"), "inside");

    // The sandbox's side: the file itself and its parent directory flip between a regular
    // entry and a symlink to the outside, as fast as it can.
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      const { directory, outside } = workerData;
      parentPort.postMessage("ready");
      for (;;) {
        try {
          fs.symlinkSync(outside + "/file.txt", directory + "/file.link");
          fs.renameSync(directory + "/file.link", directory + "/file.txt");
          fs.writeFileSync(directory + "/file.regular", "inside");
          fs.renameSync(directory + "/file.regular", directory + "/file.txt");
          fs.renameSync(directory + "/docs", directory + "/docs.real");
          fs.symlinkSync(outside, directory + "/docs");
          fs.unlinkSync(directory + "/docs");
          fs.renameSync(directory + "/docs.real", directory + "/docs");
        } catch {}
      }
    `, { eval: true, workerData: { directory, outside } });
    await new Promise((resolve) => worker.once("message", resolve));
    try {
      const deadline = Date.now() + 3_000;
      let attempts = 0;
      while (Date.now() < deadline) {
        attempts += 1;
        for (const path of ["file.txt", "docs/file.txt"]) {
          const read = await readWorkspaceFile(root, WORKSPACE_ID, path).catch(() => null);
          expect(read?.toString()).not.toBe("OUTSIDE_WORKSPACE_SENTINEL");
        }
        await writeWorkspaceFile(root, WORKSPACE_ID, "docs/written.txt", Buffer.from("x")).catch(() => undefined);
        await deleteWorkspaceFile(root, WORKSPACE_ID, "docs/secret.txt").catch(() => undefined);
        const listed = await listWorkspaceStoredFilesUnder(root, WORKSPACE_ID, "docs").catch(() => []);
        expect(listed.map((file) => file.path)).not.toContain("docs/secret.txt");
      }
      expect(attempts).toBeGreaterThan(50);
    } finally {
      await worker.terminate();
    }
    // Nothing was written into or deleted from the outside directory.
    expect(existsSync(join(outside, "written.txt"))).toBe(false);
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("OUTSIDE_WORKSPACE_SENTINEL");
  }, 30_000);
});
