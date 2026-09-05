/**
 * Eve sandbox backend to runner integration tests.
 *
 * Constructs covered:
 * - Lazy session creation only when the first sandbox operation actually runs.
 * - One atomic seed bundle instead of per-file runner mutations.
 * - Stable thread-scoped compute identity across changing Eve workflow roots.
 * - Reconnect metadata recreates disposable compute without rerunning `onSession`.
 * - Automatic trusted/restricted classification from workspace scopes.
 * - Disabled internal sessions persist no mounts and cannot start sandbox compute.
 * - Shell and binary file delegation with workspace mutation indexing.
 * - Authored stop and server shutdown independently stop reattachable compute.
 */
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxEngine } from "../../../services/sandbox-runner/sandbox-engine.js";
import { createSandboxRunnerServer } from "../../../services/sandbox-runner/server.js";
import { scopedWorkspaceRunner } from "./runner-sandbox-backend.js";
import { authorizeCurrentExternalGroupCapability } from "../tool-policy/external-group-live-policy.js";
import { externalGroupBash } from "../tool-policy/external-group-bash.js";

const policy = vi.hoisted(() => ({ tools: [] as string[] }));
vi.mock("../database.js", () => ({
  database: () => ({ connect: async () => ({
    query: async () => ({ rows: [{ tool_allowlist: policy.tools }] }),
    release: () => undefined,
  }) }),
}));

const SESSION_ID = "wrun_01JZ8K4R0W6G73VTHX9NF2QABC";
const BACKEND_SESSION_ID =
  "eve-sbx-ses-osinara-scoped-runner-local-a1b2c3d4e5f6-wrun_01JZ8K4R0W6G73VTHX9NF2QABC-__root__";
const SANDBOX_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
const servers: Array<ReturnType<typeof createSandboxRunnerServer>> = [];

function fakeEngine(): SandboxEngine {
  return {
    createSession: vi.fn(async (request) => ({
      created: request.seedFiles !== undefined,
      seedRequired: request.seedFiles === undefined,
      sessionId: request.sandboxSessionId,
      instanceId: "f".repeat(64),
    })),
    deleteToolEnvironment: vi.fn(async () => undefined),
    health: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new TextEncoder().encode("content")),
    removePath: vi.fn(async () => undefined),
    runGoogleWorkspace: vi.fn(async () => ({
      exitCode: 0,
      processId: "gws-process-1",
      stderr: "",
      stdout: "{}",
    })),
    runProcess: vi.fn(async () => ({
      exitCode: 0,
      processId: "process-1",
      stderr: "",
      stdout: "ok\n",
    })),
    stopAllSessions: vi.fn(async () => undefined),
    reconcileIdleSessions: vi.fn(async () => ({ removed: 0, stopped: 0 })),
    stopSession: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  };
}

async function runnerUrl(engine: SandboxEngine): Promise<string> {
  const server = createSandboxRunnerServer({ engine });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  policy.tools = [];
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  ));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("scopedWorkspaceRunner", () => {
  it.each([false, true])("passes the Bash requirement through Eve's public executor (revoked=%s)", async (revoked) => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({ baseUrl: await runnerUrl(engine) });
    const handle = await backend.create({
      runtimeContext: { appRoot }, sessionKey: BACKEND_SESSION_ID,
      templateKey: null, tags: { sessionId: SESSION_ID },
    });
    await handle.useSessionFn({
      mounts: [{ mountPoint: "group", workspaceId: WORKSPACE_ID }], sandboxSessionId: SANDBOX_SESSION_ID,
    });
    policy.tools = ["bash"];
    const operation = externalGroupBash.execute({ command: "touch /workspace/group/marker" }, {
      session: { auth: { current: {
        authenticator: "telegram", principalType: "user", principalId: "telegram:101",
        attributes: { familyId: "family", groupId: "group", groupType: "external", role: "external", telegramChatType: "supergroup" },
      } } },
      async getSandbox() {
        // The first authorization already passed, but the sandbox has not been selected yet.
        if (revoked) policy.tools = [];
        return handle.session;
      },
    } as never);
    if (revoked) {
      await expect(operation).rejects.toThrow("AGENT_GROUP_TOOL_FORBIDDEN");
      expect(engine.runProcess).not.toHaveBeenCalled();
    } else {
      await expect(operation).resolves.toMatchObject({ stdout: "ok\n", truncated: false });
      expect(engine.createSession).toHaveBeenCalledWith(expect.objectContaining({ access: "group-tools" }));
      expect(engine.runProcess).toHaveBeenCalledWith(SANDBOX_SESSION_ID,
        expect.objectContaining({ expectedInstanceId: "f".repeat(64) }), expect.any(AbortSignal));
    }
  });
  it.each(["run", "spawn"] as const)("rejects %s after Bash is revoked between the outer check and container selection", async (method) => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({ baseUrl: await runnerUrl(engine) });
    const handle = await backend.create({
      runtimeContext: { appRoot }, sessionKey: BACKEND_SESSION_ID,
      templateKey: null, tags: { sessionId: SESSION_ID },
    });
    await handle.useSessionFn({
      mounts: [{ mountPoint: "group", workspaceId: WORKSPACE_ID }], sandboxSessionId: SANDBOX_SESSION_ID,
    });
    policy.tools = ["bash"];
    await authorizeCurrentExternalGroupCapability({ familyId: "family", groupId: "group" }, "bash");
    policy.tools = [];
    const command = { command: "touch /workspace/group/forbidden", requiredGroupCapability: "bash" as const };
    await expect(handle.session[method](command)).rejects.toThrow("AGENT_GROUP_TOOL_FORBIDDEN");
    expect(engine.createSession).not.toHaveBeenCalled();
    expect(engine.runProcess).not.toHaveBeenCalled();
    // Native file tools may still use internal shell commands without a user Bash grant.
    await expect(handle.session.readTextFile({ path: "/workspace/group/kept" })).resolves.toBe("content");
  });
  it("persists a disabled session without creating sandbox compute", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({ baseUrl: await runnerUrl(engine) });
    const initial = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: null,
      tags: { sessionId: SESSION_ID },
    });

    await initial.useSessionFn({ mounts: [], sandboxSessionId: SANDBOX_SESSION_ID });
    const captured = await initial.captureState();

    expect(captured.metadata).toEqual({
      disabled: true,
      mounts: [],
      sandboxSessionId: SANDBOX_SESSION_ID,
      version: 3,
    });
    expect(initial.session.id).toBe(SANDBOX_SESSION_ID);
    await expect(initial.session.run({ command: "true" })).rejects.toThrowError(
      /AGENT_SANDBOX_RUNNER_SESSION_DISABLED/,
    );
    await initial.stop();
    await initial.shutdown();
    expect(engine.createSession).not.toHaveBeenCalled();
    expect(engine.stopSession).not.toHaveBeenCalled();

    // Reconnect keeps the same disabled state and still cannot reach the runner.
    const restored = await backend.create({
      existingMetadata: captured.metadata,
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: null,
      tags: { sessionId: SESSION_ID },
    });
    expect(restored.session.id).toBe(SANDBOX_SESSION_ID);
    await expect(restored.session.readTextFile({ path: "note.txt" })).rejects.toThrowError(
      /AGENT_SANDBOX_RUNNER_SESSION_DISABLED/,
    );
    expect(engine.createSession).not.toHaveBeenCalled();
  });

  it("delegates a trusted persistent workspace after mounts are known", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({
      baseUrl: await runnerUrl(engine),
    });
    await backend.prewarm({
      runtimeContext: { appRoot },
      seedFiles: [{ content: "skill", path: "$HOME/.agents/skills/example/SKILL.md" }],
      templateKey: "template-1",
    });
    const handle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: "template-1",
      tags: { sessionId: SESSION_ID },
    });

    expect(engine.createSession).not.toHaveBeenCalled();
    await handle.useSessionFn({
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });
    expect(engine.createSession).not.toHaveBeenCalled();
    await expect(handle.session.run({ command: "printf ok" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
    });
    expect(engine.writeFile).not.toHaveBeenCalled();
    await handle.session.writeTextFile({ path: "note.txt", content: "hello" });
    await expect(handle.session.readTextFile({ path: "note.txt" })).resolves.toBe("content");

    expect(engine.createSession).toHaveBeenCalledWith({
      access: "trusted",
      eveSessionId: SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      seedFiles: [{
        contentBase64: Buffer.from("skill").toString("base64"),
        path: "/tools/personal/home/.agents/skills/example/SKILL.md",
      }],
    });
    expect(handle.session.id).toBe(SANDBOX_SESSION_ID);
    await handle.stop();
    expect(engine.stopSession).toHaveBeenCalledWith(SANDBOX_SESSION_ID);
    vi.mocked(engine.stopSession).mockClear();

    // Shutdown remains authoritative even when an authored callback stopped compute earlier.
    await handle.shutdown();
    expect(engine.stopSession).toHaveBeenCalledWith(SANDBOX_SESSION_ID);
  });

  it("classifies a group-only session as restricted and rejects network escalation", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({ baseUrl: await runnerUrl(engine) });
    const handle = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: null,
      tags: { sessionId: SESSION_ID },
    });
    await handle.useSessionFn({
      mounts: [{ mountPoint: "group", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });

    await handle.session.run({ command: "true" });
    expect(engine.createSession).toHaveBeenCalledWith(expect.objectContaining({ access: "restricted" }));
    await expect(handle.session.setNetworkPolicy("allow-all")).rejects.toThrowError(
      /AGENT_SANDBOX_RUNNER_NETWORK_POLICY_FORBIDDEN/,
    );
  });

  it("restores mounts and recreates disposable compute from captured backend metadata", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "osinara-runner-backend-"));
    roots.push(appRoot);
    const engine = fakeEngine();
    const backend = scopedWorkspaceRunner({ baseUrl: await runnerUrl(engine) });
    const initial = await backend.create({
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: null,
      tags: { sessionId: SESSION_ID },
    });
    await initial.useSessionFn({
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
    });
    const captured = await initial.captureState();
    const restored = await backend.create({
      existingMetadata: captured.metadata,
      runtimeContext: { appRoot },
      sessionKey: BACKEND_SESSION_ID,
      templateKey: null,
      tags: { sessionId: SESSION_ID },
    });
    vi.mocked(engine.createSession).mockClear();

    await expect(restored.session.run({ command: "printf restored" })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(engine.createSession).toHaveBeenCalledWith({
      access: "trusted",
      eveSessionId: SESSION_ID,
      mounts: [{ mountPoint: "personal", workspaceId: WORKSPACE_ID }],
      sandboxSessionId: SANDBOX_SESSION_ID,
      seedDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      seedFiles: [],
    });
    expect(engine.runProcess).toHaveBeenLastCalledWith(
      SANDBOX_SESSION_ID,
      expect.objectContaining({ command: "printf restored" }),
      expect.any(AbortSignal),
    );
    await expect(restored.session.setNetworkPolicy("allow-all")).resolves.toBeUndefined();
  });
});
