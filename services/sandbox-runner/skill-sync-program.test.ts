/** Real filesystem integrity checks, with no Docker or application processes. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_SYNC_PROGRAM } from "./skill-sync-program.js";

async function sync(home: string, packages: unknown[], removed: string[] = []) {
  const process = spawn(globalThis.process.execPath, ["-e", SKILL_SYNC_PROGRAM], { env: { ...globalThis.process.env, HOME: home } });
  let stdout = "", stderr = "";
  process.stdout.on("data", (data) => { stdout += data; }); process.stderr.on("data", (data) => { stderr += data; });
  process.stdin.end(JSON.stringify({ packages, removed }));
  await new Promise<void>((resolve, reject) => { process.on("error", reject); process.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr))); });
  return JSON.parse(stdout);
}

describe("verified skill synchronization", () => {
  it("does not rewrite intact files, repairs tampering, and removes revoked packages only", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: Buffer.from("reviewed").toString("base64") }] }];
    try {
      expect(await sync(home, packages)).toEqual({ checked: 1, written: 1, removed: 0 });
      const path = join(home, ".agents/skills/test/SKILL.md");
      const first = await stat(path);
      expect(await sync(home, packages)).toEqual({ checked: 1, written: 0, removed: 0 });
      expect((await stat(path)).mtimeMs).toBe(first.mtimeMs);
      await writeFile(path, "tampered");
      expect((await sync(home, packages)).written).toBe(1);
      expect(await readFile(path, "utf8")).toBe("reviewed");
      await writeFile(join(home, "user-data.txt"), "kept");
      expect((await sync(home, [], ["test"])).removed).toBe(1);
      expect(await readFile(join(home, "user-data.txt"), "utf8")).toBe("kept");
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(home, { force: true, recursive: true }); }
  });

  it("rejects a symlink instead of reading or overwriting its target", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    try {
      const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: Buffer.from("reviewed").toString("base64") }] }];
      await sync(home, packages);
      const path = join(home, ".agents/skills/test/SKILL.md");
      const target = join(home, "private-data"); await writeFile(target, "secret");
      await rm(path); await symlink(target, path);
      await expect(sync(home, packages)).rejects.toThrow("AGENT_SKILL_SYNC_PATH_UNSAFE");
      expect(await readFile(target, "utf8")).toBe("secret");
    } finally { await rm(home, { force: true, recursive: true }); }
  });
});
