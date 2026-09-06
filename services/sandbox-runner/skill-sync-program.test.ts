/** Real filesystem integrity checks, with no Docker or application processes. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_SYNC_PROGRAM } from "./skill-sync-program.js";

async function sync(home: string, packages: unknown[], removed: string[] = [], prefix = "") {
  const process = spawn(globalThis.process.execPath, ["--max-old-space-size=64", "-e", prefix + SKILL_SYNC_PROGRAM], { env: { ...globalThis.process.env, HOME: home } });
  let stdout = "", stderr = "";
  process.stdout.on("data", (data) => { stdout += data; }); process.stderr.on("data", (data) => { stderr += data; });
  process.stdin.end(JSON.stringify({ packages, removed }));
  await new Promise<void>((resolve, reject) => { process.on("error", reject); process.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr))); });
  return JSON.parse(stdout);
}

describe("verified skill synchronization", () => {
  it("repairs an oversized managed file without reading gigabytes into memory", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: Buffer.from("reviewed").toString("base64") }] }];
    try {
      await sync(home, packages);
      const path = join(home, ".agents/skills/test/SKILL.md");
      await truncate(path, 4 * 1024 ** 3);
      expect((await sync(home, packages)).written).toBe(1);
      expect(await readFile(path, "utf8")).toBe("reviewed");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("preserves supporting filenames when UTF-8 characters cross stdin chunks", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [
      { path: "SKILL.md", contentBase64: "b2s=" }, { path: "данные.txt", contentBase64: "b2s=" },
    ] }];
    const bytes = Buffer.from(JSON.stringify({ packages, removed: [] }));
    const split = bytes.indexOf(Buffer.from("данные")) + 1;
    const prefix = `Object.defineProperty(process,'stdin',{value:require('node:stream').Readable.from([Buffer.from('${bytes.subarray(0, split).toString("base64")}','base64'),Buffer.from('${bytes.subarray(split).toString("base64")}','base64')])});`;
    try {
      await sync(home, packages, [], prefix);
      expect(await readFile(join(home, ".agents/skills/test/данные.txt"), "utf8")).toBe("ok");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("does not follow a parent directory swapped to a symlink after it was opened", async () => {
    const home = await mkdtemp(join(tmpdir(), "osinara-skill-sync-"));
    const packages = [{ name: "test", files: [{ path: "SKILL.md", contentBase64: "b2s=" }] }];
    try {
      await sync(home, packages);
      const original = join(home, ".agents/skills/test"), moved = join(home, "moved"), outside = join(home, "outside");
      await mkdir(outside); await writeFile(join(outside, "SKILL.md"), "private");
      const prefix = `const testFs=require('node:fs/promises'),testOpen=testFs.open;let testSwapped=false;testFs.open=async function(path,...args){const handle=await testOpen.call(this,path,...args);if(!testSwapped&&String(path).endsWith('/test')){testSwapped=true;await testFs.rename(${JSON.stringify(original)},${JSON.stringify(moved)});await testFs.symlink(${JSON.stringify(outside)},${JSON.stringify(original)});}return handle;};`;
      await expect(sync(home, packages, [], prefix)).rejects.toThrow("AGENT_SKILL_SYNC_PATH_CHANGED");
      expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe("private");
    } finally { await rm(home, { recursive: true, force: true }); }
  });

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
