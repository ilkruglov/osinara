/**
 * Workspace path policy tests.
 *
 * Construct covered:
 * - `validateWorkspacePath`: canonical relative POSIX paths without traversal or aliases, each
 *   segment within Linux's 255 bytes, so a long name is refused as a path, not by the kernel.
 */
import { describe, expect, it } from "vitest";

import { validateWorkspacePath } from "./workspace-path.js";

describe("validateWorkspacePath", () => {
  it("accepts a canonical nested relative path", () => {
    expect(validateWorkspacePath("documents/план.txt")).toBe("documents/план.txt");
  });

  it("accepts a segment of 255 bytes and refuses one of 256", () => {
    expect(validateWorkspacePath(`docs/${"я".repeat(127)}a`)).toBe(`docs/${"я".repeat(127)}a`);
    expect(() => validateWorkspacePath(`docs/${"я".repeat(128)}`)).toThrowError(
      /AGENT_WORKSPACE_PATH_INVALID/,
    );
  });

  it.each(["", "/etc/passwd", "../secret", "a/../secret", "a//b", "a\\b", ".hidden/./x"])(
    "rejects unsafe or non-canonical path %s",
    (path) =>
      expect(() => validateWorkspacePath(path)).toThrowError(/AGENT_WORKSPACE_PATH_INVALID/),
  );
});
