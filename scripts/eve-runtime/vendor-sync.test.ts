/**
 * The vendored copies of our runtime modules match their TypeScript sources.
 *
 * Constructs covered:
 * - Every module in `EVE_RUNTIME_MODULES` is in `vendor/` exactly as its source compiles; a stale
 *   copy means `npm run sync:eve-runtime` was not run after an edit.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { builtEveRuntimeModule, EVE_RUNTIME_MODULES, projectPath } from "../sync-eve-runtime.ts";

describe("vendored Eve runtime modules", () => {
  it.each(EVE_RUNTIME_MODULES)("%s is built into %s", async (source, target) => {
    expect(await readFile(projectPath(target), "utf8")).toBe(await builtEveRuntimeModule(source));
  });
});
