/**
 * External-group native file-tool override tests.
 *
 * Constructs covered:
 * - Same-name Eve overrides authorize every execution against current group state.
 * - Canonical sandbox paths remain inside the exact `/workspace/group` root.
 * - Symlink components cannot redirect an operation outside the group workspace.
 * - Allowed paths retain Eve's native executor contracts.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDefinition } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { createExternalGroupFileTools } from "./external-group-file-tools.js";

const GROUP_ROOT = "/workspace/group";
const AUTHORIZATION = {
  familyId: "family-1",
  groupId: "group-1",
  groupType: "external" as const,
  role: "external" as const,
  telegramChatType: "supergroup" as const,
  userId: null,
};

function tool(execute: ReturnType<typeof vi.fn>): ToolDefinition<any, any> {
  return {
    description: "Eve default",
    execute,
    inputSchema: {},
  } as ToolDefinition<any, any>;
}

function context() {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            familyId: AUTHORIZATION.familyId,
            groupId: AUTHORIZATION.groupId,
            groupType: AUTHORIZATION.groupType,
            role: AUTHORIZATION.role,
            telegramChatType: AUTHORIZATION.telegramChatType,
          },
          authenticator: "telegram",
          principalId: "telegram:external",
          principalType: "user",
        },
        initiator: null,
      },
    },
  } as never;
}

describe("external-group file tools", () => {
  let root: string;
  let authorize: Mock<(auth: WorkspaceAuthorization) => Promise<string>>;
  let executors: Record<"glob" | "grep" | "read_file" | "write_file", ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "osinara-external-files-"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "allowed.txt"), "allowed\n");
    authorize = vi.fn(async (_auth: WorkspaceAuthorization) => root);
    executors = {
      glob: vi.fn(async (input) => ({ input })),
      grep: vi.fn(async (input) => ({ input })),
      read_file: vi.fn(async (input) => ({ input })),
      write_file: vi.fn(async (input) => ({ input })),
    };
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  function tools() {
    return createExternalGroupFileTools({
      defaults: {
        glob: tool(executors.glob),
        grep: tool(executors.grep),
        read_file: tool(executors.read_file),
        write_file: tool(executors.write_file),
      },
      authorize,
    });
  }

  it.each([
    ["glob", { path: `${GROUP_ROOT}/../personal`, pattern: "**/*" }],
    ["grep", { path: "/tmp", pattern: "secret" }],
    ["read_file", { filePath: `${GROUP_ROOT}/../../tools/family/home/token` }],
    ["write_file", { content: "escape", filePath: "/workspace/family/escape.txt" }],
  ] as const)("rejects traversal or a sibling root through %s", async (name, input) => {
    await expect(tools()[name]!.execute(input, context())).rejects.toThrowError(
      /AGENT_GROUP_FILE_PATH_FORBIDDEN/u,
    );
    expect(executors[name]).not.toHaveBeenCalled();
  });

  it("rejects a symlink that escapes the group workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "osinara-external-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(outside, join(root, "escape"));

    try {
      await expect(tools().read_file!.execute(
        { filePath: `${GROUP_ROOT}/escape/secret.txt` },
        context(),
      )).rejects.toThrowError(/AGENT_GROUP_FILE_PATH_FORBIDDEN/u);
      expect(executors.read_file).not.toHaveBeenCalled();
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it.each([
    ["glob", { pattern: "**/*.txt" }],
    ["grep", { pattern: "allowed" }],
    ["read_file", { filePath: `${GROUP_ROOT}/docs/allowed.txt` }],
    ["write_file", { content: "new", filePath: `${GROUP_ROOT}/docs/new.txt` }],
  ] as const)("denies stale-session execution through %s", async (name, input) => {
    authorize.mockRejectedValueOnce(
      new Error("AGENT_WORKSPACE_ACCESS_DENIED: Группа больше не имеет доступа к workspace"),
    );

    await expect(tools()[name]!.execute(input, context())).rejects.toThrowError(
      /AGENT_WORKSPACE_ACCESS_DENIED/u,
    );
    expect(executors[name]).not.toHaveBeenCalled();
  });

  it.each([
    ["glob", { pattern: "**/*.txt" }, { path: GROUP_ROOT, pattern: "**/*.txt" }],
    ["grep", { pattern: "allowed" }, { path: GROUP_ROOT, pattern: "allowed" }],
    [
      "read_file",
      { filePath: `${GROUP_ROOT}/docs/allowed.txt` },
      { filePath: `${GROUP_ROOT}/docs/allowed.txt` },
    ],
    [
      "write_file",
      { content: "new", filePath: `${GROUP_ROOT}/docs/new.txt` },
      { content: "new", filePath: `${GROUP_ROOT}/docs/new.txt` },
    ],
  ] as const)("executes %s for an allowed canonical group path", async (name, input, expected) => {
    await tools()[name]!.execute(input, context());

    expect(authorize).toHaveBeenCalledWith(AUTHORIZATION);
    expect(executors[name]).toHaveBeenCalledWith(expected, context());
  });

});
