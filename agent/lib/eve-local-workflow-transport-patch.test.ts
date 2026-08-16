/**
 * Eve local Workflow transport patch contract tests.
 *
 * Constructs covered:
 * - Self-delivery waits longer than Workflow's four-minute replay window.
 * - The version-pinned postinstall patch owns the reviewed bundled artifact change.
 * - The patched minified runtime remains syntactically valid.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const LOCAL_WORLD_PATH =
  "node_modules/eve/dist/src/compiled/@workflow/world-local/index.js";
const PATCHED_TIMEOUT_MARKER =
  "function mn(){return{bodyTimeout:pn(`WORKFLOW_LOCAL_BODY_TIMEOUT_MS`,3e5),connections:1e3,headersTimeout:pn(`WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS`,3e5),keepAliveTimeout:3e4}}";
const UNPATCHED_TIMEOUT_MARKER =
  "function mn(){return{bodyTimeout:pn(`WORKFLOW_LOCAL_BODY_TIMEOUT_MS`,3e4),connections:1e3,headersTimeout:pn(`WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS`,3e4),keepAliveTimeout:3e4}}";
const execFileAsync = promisify(execFile);

describe("Eve local Workflow transport patch", () => {
  it("keeps self-delivery alive for five minutes", async () => {
    const [evePackageSource, patchSource, runtime] = await Promise.all([
      readFile("node_modules/eve/package.json", "utf8"),
      readFile("scripts/apply-eve-patches.ts", "utf8"),
      readFile(LOCAL_WORLD_PATH, "utf8"),
    ]);
    const evePackage = JSON.parse(evePackageSource) as { version?: string };

    expect(evePackage.version).toBe("0.32.0");
    expect(patchSource).toContain("const EVE_LOCAL_WORKFLOW_TRANSPORT_TIMEOUT_MS = 300_000;");
    expect(runtime).toContain(PATCHED_TIMEOUT_MARKER);
    expect(runtime).not.toContain(UNPATCHED_TIMEOUT_MARKER);
  });

  it("keeps the patched bundled transport syntactically valid", async () => {
    await expect(execFileAsync(process.execPath, ["--check", LOCAL_WORLD_PATH])).resolves.toMatchObject({
      stderr: "",
    });
  });
});
