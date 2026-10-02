/**
 * Eve skill materialization patch tests.
 *
 * Constructs covered:
 * - Skill packages and their files reach the sandbox in parallel, not one round trip at a time.
 * - Both patched runtime modules stay syntactically valid.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { codeShape, codeText } from "./vendored-code.js";

const LIFECYCLE_PATH = "vendor/eve/dist/src/context/dynamic-skill-lifecycle.js";
const PACKAGE_PATH = "vendor/eve/dist/src/shared/skill-package.js";
const execFileAsync = promisify(execFile);

describe("Eve skill materialization patch", () => {
  it("writes every package file in one round trip instead of a sequential chain", async () => {
    const [lifecycle, skillPackage] = await Promise.all([
      readFile(LIFECYCLE_PATH, "utf8"),
      readFile(PACKAGE_PATH, "utf8"),
    ]);

    // Eve rewrites every dynamic package on every turn; sequential writes cost one container
    // round trip per file, 2-5 seconds per external-group turn (10 сентября 2026).
    expect(codeShape(lifecycle)).not.toContain(codeShape("for(let{skills:e}of p)for(let t of e)await writeSkillPackageToSandbox"));
    expect(codeText(lifecycle)).toContain(codeText("await Promise.all( p.flatMap"));
    expect(codeShape(skillPackage)).not.toContain(codeShape("for(let t of e.skill.files)await e.sandbox.writeBinaryFile"));
    expect(codeText(skillPackage)).toContain(codeText("await Promise.all( e.skill.files.map"));
  });

  it("keeps both patched skill runtimes syntactically valid", async () => {
    for (const path of [LIFECYCLE_PATH, PACKAGE_PATH]) {
      await expect(execFileAsync(process.execPath, ["--check", path])).resolves.toMatchObject({
        stderr: "",
      });
    }
  });
});
