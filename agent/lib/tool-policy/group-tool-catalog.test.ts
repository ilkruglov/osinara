/**
 * External group tool catalog completeness tests.
 *
 * Constructs covered:
 * - `CONTROLLED_TOOL_NAMES`: covers every static authored tool so new tools cannot bypass policy.
 * - Capability metadata: provides generated model usage for every effective external capability.
 */
import { readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  CONTROLLED_TOOL_NAMES,
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  EXTERNAL_GROUP_TOOL_NAMES,
  SANDBOX_FILE_CAPABILITY_CATALOG,
} from "./group-tool-catalog.js";

describe("external group tool catalog", () => {
  it("covers every static authored tool", async () => {
    const entries = await readdir(new URL("../../tools", import.meta.url));
    const staticToolNames = entries
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => name.slice(0, -3))
      .filter((name) => name !== "group-tool-policy")
      .sort();

    expect(CONTROLLED_TOOL_NAMES).toEqual(expect.arrayContaining(staticToolNames));
  });

  it("does not override native file tools in isolated external workspaces", () => {
    expect(ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES).toEqual([
      "glob",
      "grep",
      "read_file",
      "write_file",
    ]);
    for (const toolName of ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES) {
      expect(CONTROLLED_TOOL_NAMES).not.toContain(toolName);
    }
  });

  it("does not expose the removed PDF parser capability", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).not.toContain("inspect_workspace_pdf");
    expect(CONTROLLED_TOOL_NAMES).not.toContain("inspect_workspace_pdf");
  });

  it("defines non-empty model usage for every persisted and always-available capability", () => {
    expect(EXTERNAL_GROUP_CAPABILITY_CATALOG.map(({ name }) => name)).toEqual(
      EXTERNAL_GROUP_TOOL_NAMES,
    );
    expect(SANDBOX_FILE_CAPABILITY_CATALOG.map(({ name }) => name)).toEqual(
      ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
    );
    for (const capability of [
      ...EXTERNAL_GROUP_CAPABILITY_CATALOG,
      ...SANDBOX_FILE_CAPABILITY_CATALOG,
    ]) {
      expect(capability.usage.trim()).not.toBe("");
    }
  });

  it("offers controlled provider search and proxied fetch as persisted grants", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).toEqual(
      expect.arrayContaining(["web_search", "web_fetch"]),
    );
  });
});
