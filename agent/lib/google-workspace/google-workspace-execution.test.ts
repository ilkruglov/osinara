/**
 * Credentialed Google Workspace execution boundary tests.
 *
 * Constructs covered:
 * - Mutations require Eve HITL while reads do not.
 * - Execution rechecks current access/profile after approval and preserves scope isolation.
 * - Exact argv transport treats shell metacharacters as ordinary data.
 */
import { describe, expect, it, vi } from "vitest";

import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";
import executeGoogleWorkspace, {
  createGoogleWorkspaceExecutor,
} from "../tools/execute_google_workspace.js";

const personalAuth = {
  familyId: "00000000-0000-4000-8000-000000000001",
  role: "owner" as const,
  scope: "personal" as const,
  telegramUserId: "101",
  userId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
};
const familyAuth = {
  ...personalAuth,
  scope: "family" as const,
  workspaceId: "00000000-0000-4000-8000-000000000004",
};

function approval(argv: string[]) {
  return (executeGoogleWorkspace as unknown as {
    approval: (context: { toolInput?: { argv: string[] } }) => unknown;
  }).approval({ toolInput: { argv } });
}

function toolDescription(): string {
  return (executeGoogleWorkspace as unknown as { description: string }).description;
}

function dependencies(auth: GoogleIntegrationAuthorization = personalAuth) {
  return {
    resolveAuthorization: vi.fn().mockResolvedValue(auth),
    run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "{}" }),
    withAuthorizedExecution: vi.fn(async <T>(
      _auth: GoogleIntegrationAuthorization,
      operation: (accessToken: string) => Promise<T>,
    ): Promise<T> => await operation("live-access-token")),
  };
}

describe("execute_google_workspace approval", () => {
  it("requires approval for every mutation and denies unreviewed commands", () => {
    expect(approval(["calendar", "events", "list", "--params", "{}"])).toBe(
      "not-applicable",
    );
    expect(approval(["calendar", "events", "insert", "--json", "{}"])).toBe(
      "user-approval",
    );
    expect(approval(["auth", "export"])).toMatchObject({ type: "denied" });
  });

  it("tells the model to keep API route segments in separate argv entries", () => {
    expect(toolDescription()).toContain('"gmail", "users", "messages", "trash"');
    expect(toolDescription()).toContain("не объединяйте их через точку");
  });
});

describe("createGoogleWorkspaceExecutor", () => {
  it("does not execute after a mid-turn membership revocation", async () => {
    const deps = dependencies();
    deps.withAuthorizedExecution.mockRejectedValueOnce(
      new Error("AGENT_GOOGLE_WORKSPACE_ACCESS_DENIED: Доступ отозван"),
    );
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute({ argv: ["calendar", "events", "insert", "--json", "{}"] }, {} as never))
      .rejects.toThrowError(/AGENT_GOOGLE_WORKSPACE_ACCESS_DENIED/u);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it.each([personalAuth, familyAuth])("uses only the live $scope profile", async (auth) => {
    const deps = dependencies(auth);
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await execute({ argv: ["calendar", "events", "list", "--params", "{}"] }, {} as never);

    expect(deps.withAuthorizedExecution).toHaveBeenCalledWith(auth, expect.any(Function));
    expect(deps.run).toHaveBeenCalledWith(
      ["calendar", "events", "list", "--params", "{}"],
      "read",
      auth,
      "live-access-token",
      expect.anything(),
    );
  });

  it("passes shell metacharacters as one unchanged argument", async () => {
    const deps = dependencies();
    const execute = createGoogleWorkspaceExecutor(deps as never);
    const dangerous = '$(touch /tmp/pwned); `id`; a && rm -rf /';

    await execute({
      argv: ["gmail", "+send", "--to", "a@example.com", "--subject", dangerous],
    }, {} as never);

    expect(deps.run.mock.calls[0]?.[0][5]).toBe(dangerous);
  });

  it("keeps live authorization active through the credentialed command", async () => {
    const deps = dependencies();
    let authorizationActive = false;
    deps.withAuthorizedExecution.mockImplementationOnce(async (_auth, operation) => {
      authorizationActive = true;
      try {
        return await operation("live-access-token");
      } finally {
        authorizationActive = false;
      }
    });
    deps.run.mockImplementationOnce(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ authorizationActive }),
    }));
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute(
      { argv: ["calendar", "events", "list", "--params", "{}"] },
      {} as never,
    )).resolves.toMatchObject({ stdout: "{\"authorizationActive\":true}" });
    expect(authorizationActive).toBe(false);
  });

  it("rejects oversized output before it reaches the next model call", async () => {
    const deps = dependencies();
    deps.run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: "x".repeat(300_000),
    });
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute(
      { argv: ["calendar", "events", "list", "--params", "{}"] },
      {} as never,
    )).rejects.toThrowError(/AGENT_GOOGLE_WORKSPACE_OUTPUT_TOO_LARGE/u);
  });

  it("reports bounded success after an oversized mutation result", async () => {
    const deps = dependencies();
    deps.run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "details".repeat(50_000),
      stdout: "result".repeat(50_000),
    });
    const execute = createGoogleWorkspaceExecutor(deps as never);

    await expect(execute(
      { argv: ["calendar", "events", "insert", "--json", "{}"] },
      {} as never,
    )).resolves.toEqual({
      completed: true,
      kind: "mutation",
      outputBytes: expect.any(Number),
      outputTruncated: true,
      scope: "personal",
      stderr: "",
      stdout: "",
    });
  });
});
