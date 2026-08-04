/**
 * External group tool catalog completeness tests.
 *
 * Constructs covered:
 * - `FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS`: covers the Eve built-ins that cannot be hidden.
 * - Capability metadata: provides generated model usage for every effective external capability.
 */
import { describe, expect, it } from "vitest";

import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  EXTERNAL_GROUP_TOOL_NAMES,
  FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
  SANDBOX_FILE_CAPABILITY_CATALOG,
} from "./group-tool-catalog.js";

describe("external group tool catalog", () => {
  it("denies every framework built-in an external group must not reach", () => {
    // Application tools are emitted per mode, so only framework descriptors need an override.
    expect([...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS].sort()).toEqual([
      "ask_question",
      "bash",
      "todo",
      "web_fetch",
      "web_search",
    ]);
  });

  it("does not override native file tools in isolated external workspaces", () => {
    expect(ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES).toEqual([
      "glob",
      "grep",
      "read_file",
      "write_file",
    ]);
    for (const toolName of ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES) {
      expect(FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS).not.toContain(toolName);
    }
  });

  it("does not expose the removed PDF parser capability", () => {
    expect(EXTERNAL_GROUP_TOOL_NAMES).not.toContain("inspect_workspace_pdf");
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
