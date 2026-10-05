/**
 * The browser companion container of a trusted sandbox session.
 *
 * Constructs covered:
 * - Browser commands run in a companion created from the session's container: the same workspace
 *   mounts at the same paths, browser state from `browser/<workspace>` of the tools volume instead
 *   of the tool environment, the logged-in session in its environment, no Browserless key, the
 *   session label for capacity and idle stop, and a role label.
 * - The logged-in restore state moves out of the tool environment Bash mounts, once; the
 *   browser's own state wins over an older copy, which is removed.
 * - A restricted session has no browser; a companion from an older policy is replaced; stopping
 *   the session removes it; the repeat guard of the model's Bash does not apply.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import { migrateBrowserState, sandboxBrowserContainerName } from "./docker-sandbox-browser.js";
import { createDockerSandboxEngine } from "./docker-sandbox-engine.js";
import { sandboxContainerName } from "./docker-sandbox-lifecycle.js";
import { buildBrowserContainerOptions, SANDBOX_CONTAINER_POLICY_VERSION } from "./docker-sandbox-options.js";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSONAL = "11111111-1111-4111-8111-111111111111";
const FAMILY = "22222222-2222-4222-8222-222222222222";
const runtime = {
  browserlessApiKey: "browserless-secret",
  egressNetwork: "osinara_sandbox-egress",
  image: "osinara-sandbox-runtime:local",
  project: "osinara",
  toolsVolume: "osinara_tool-environments",
  workspaceVolume: "osinara_workspace-data",
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function toolsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "osinara-browser-"));
  roots.push(root);
  return root;
}

const missing = Object.assign(new Error("no such container"), { statusCode: 404 });

function volume(target: string, source: string, subpath: string) {
  return { Source: source, Target: target, Type: "volume", VolumeOptions: { Subpath: subpath } };
}

/** A Docker stub with the session's own container and whatever the engine creates by name. */
function dockerWith(sessionMounts: unknown[], companion?: { labels: Record<string, string> }) {
  const created: Array<{ options: Docker.ContainerCreateOptions; started: boolean }> = [];
  const removed: string[] = [];
  const exec = vi.fn(async () => ({
    inspect: vi.fn(async () => ({ ExitCode: 0 })),
    start: vi.fn(async () => Readable.from([])),
  }));
  const containers = new Map<string, unknown>();
  containers.set(sandboxContainerName(SESSION_ID), {
    inspect: vi.fn(async () => ({
      Config: { Labels: { "dev.osinara.sandbox.eve-session-id": "wrun_1" } },
      HostConfig: { Mounts: sessionMounts },
      Id: "session",
      State: { Running: true, StartedAt: "2026-10-05T00:00:00Z" },
    })),
    remove: vi.fn(async () => { removed.push("session"); }),
  });
  if (companion) {
    containers.set(sandboxBrowserContainerName(SESSION_ID), {
      exec,
      inspect: vi.fn(async () => ({
        Config: { Labels: companion.labels },
        Id: "old-browser",
        State: { Running: true, StartedAt: "2026-10-05T00:00:00Z" },
      })),
      remove: vi.fn(async () => { removed.push("old-browser"); }),
      top: vi.fn(async () => ({ Processes: [] })),
    });
  }
  const docker = {
    createContainer: vi.fn(async (options: Docker.ContainerCreateOptions) => {
      const entry = { options, started: false };
      created.push(entry);
      const container = {
        exec,
        inspect: vi.fn(async () => ({ Config: { Labels: options.Labels }, Id: options.name, State: { Running: entry.started, StartedAt: "2026-10-05T00:00:01Z" } })),
        remove: vi.fn(async () => { removed.push(options.name!); }),
        start: vi.fn(async () => { entry.started = true; }),
        top: vi.fn(async () => ({ Processes: [] })),
      };
      containers.set(options.name!, container);
      return container;
    }),
    getContainer: vi.fn((name: string) => containers.get(name) ?? { inspect: vi.fn(async () => Promise.reject(missing)) }),
    listContainers: vi.fn(async () => []),
    modem: {
      demuxStream: vi.fn((stream: Readable, stdout: NodeJS.WritableStream) => {
        stream.pipe(stdout as NodeJS.WritableStream & import("node:stream").Writable);
      }),
    },
  } as unknown as Docker;
  return { created, docker, exec, removed };
}

describe("buildBrowserContainerOptions", () => {
  it("mounts the session's workspaces and the browser state, with the logged-in session and no Bash tools", () => {
    const options = buildBrowserContainerOptions(runtime, {
      eveSessionId: "wrun_1",
      sandboxSessionId: SESSION_ID,
      toolsWorkspaceId: PERSONAL,
      workspaceMounts: [{ mountPoint: "personal", workspaceId: PERSONAL }, { mountPoint: "family", workspaceId: FAMILY }],
    });
    expect(options.HostConfig?.Mounts).toEqual([
      expect.objectContaining(volume("/workspace/personal", runtime.workspaceVolume, PERSONAL)),
      expect.objectContaining(volume("/workspace/family", runtime.workspaceVolume, FAMILY)),
      expect.objectContaining(volume("/browser", runtime.toolsVolume, `browser/${PERSONAL}`)),
    ]);
    expect(options.Env).toEqual(expect.arrayContaining([
      "AGENT_BROWSER_SESSION=osinara",
      "AGENT_BROWSER_RESTORE=osinara",
      "HOME=/browser/home",
    ]));
    expect(options.Env?.some((entry) => entry.startsWith("BROWSERLESS_API_KEY="))).toBe(false);
    expect(options.Env?.some((entry) => entry.includes("/tools/"))).toBe(false);
    expect(options.HostConfig).toMatchObject({ CapDrop: ["ALL"], NetworkMode: runtime.egressNetwork, Privileged: false });
    expect(options.Labels).toMatchObject({
      "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION,
      "dev.osinara.sandbox.role": "browser",
      "dev.osinara.sandbox.session-id": SESSION_ID,
    });
  });
});

describe("migrateBrowserState", () => {
  it("moves the logged-in restore state out of the tool environment once and leaves the reader's", async () => {
    const root = await toolsRoot();
    const sessions = join(root, PERSONAL, "home/.agent-browser/sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "osinara-osinara.json"), "{\"cookies\":[]}");
    await writeFile(join(sessions, "osinara-reader.json"), "{}");

    await expect(migrateBrowserState(root, PERSONAL)).resolves.toBe(1);
    expect(await readdir(sessions)).toEqual(["osinara-reader.json"]);
    expect(await readdir(join(root, "browser", PERSONAL, "home/.agent-browser/sessions"))).toEqual(["osinara-osinara.json"]);
    await expect(migrateBrowserState(root, PERSONAL)).resolves.toBe(0);
  });

  it("keeps the browser's own state and removes an older copy left for Bash", async () => {
    const root = await toolsRoot();
    const sessions = join(root, PERSONAL, "home/.agent-browser/sessions");
    const browser = join(root, "browser", PERSONAL, "home/.agent-browser/sessions");
    await mkdir(sessions, { recursive: true });
    await mkdir(browser, { recursive: true });
    await writeFile(join(sessions, "osinara-osinara.json"), "old");
    await writeFile(join(browser, "osinara-osinara.json"), "current");

    await migrateBrowserState(root, PERSONAL);
    expect(await readdir(sessions)).toEqual([]);
    expect(await readdir(browser)).toEqual(["osinara-osinara.json"]);
  });
});

describe("browser target of the engine", () => {
  const trustedMounts = [
    volume("/workspace/personal", runtime.workspaceVolume, PERSONAL),
    volume("/tools/personal", runtime.toolsVolume, PERSONAL),
  ];

  it("runs a browser command in a companion created from the session's container", async () => {
    const root = await toolsRoot();
    const { created, docker, exec } = dockerWith(trustedMounts);
    const engine = createDockerSandboxEngine({ docker, roots: { toolsRoot: root, workspaceRoot: root }, runtime });

    await engine.runProcess(SESSION_ID, { command: "agent-browser get url", target: "browser" });
    await engine.runProcess(SESSION_ID, { command: "agent-browser get title", target: "browser" });

    expect(created).toHaveLength(1);
    expect(created[0]!.options.name).toBe(sandboxBrowserContainerName(SESSION_ID));
    expect(created[0]!.started).toBe(true);
    expect(created[0]!.options.HostConfig?.Mounts).toEqual([
      expect.objectContaining(volume("/workspace/personal", runtime.workspaceVolume, PERSONAL)),
      expect.objectContaining(volume("/browser", runtime.toolsVolume, `browser/${PERSONAL}`)),
    ]);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(await readdir(join(root, "browser", PERSONAL))).toContain("home");
  });

  it("has no browser beside a restricted session", async () => {
    const root = await toolsRoot();
    const { created, docker } = dockerWith([volume("/workspace/group", runtime.workspaceVolume, PERSONAL)]);
    const engine = createDockerSandboxEngine({ docker, roots: { toolsRoot: root, workspaceRoot: root }, runtime });

    await expect(engine.runProcess(SESSION_ID, { command: "agent-browser get url", target: "browser" }))
      .rejects.toThrow("AGENT_SANDBOX_RUNNER_BROWSER_UNAVAILABLE");
    expect(created).toHaveLength(0);
  });

  it("replaces a companion from an older policy and removes it with the session", async () => {
    const root = await toolsRoot();
    const { created, docker, removed } = dockerWith(trustedMounts, { labels: { "dev.osinara.sandbox.policy-version": "15" } });
    const engine = createDockerSandboxEngine({ docker, roots: { toolsRoot: root, workspaceRoot: root }, runtime });

    await engine.runProcess(SESSION_ID, { command: "agent-browser get url", target: "browser" });
    expect(removed).toEqual(["old-browser"]);
    expect(created).toHaveLength(1);

    await engine.stopSession(SESSION_ID);
    expect(removed).toEqual(["old-browser", "session", sandboxBrowserContainerName(SESSION_ID)]);
  });
});
