/**
 * The browser companion container of a trusted sandbox session.
 *
 * Exports:
 * - `sandboxBrowserContainerName`: the companion's deterministic name.
 * - `migrateBrowserState`: moves the logged-in session's restore state out of the tool
 *   environment Bash mounts, once.
 * - `requireBrowserContainer`: the running companion, created from the session's own container.
 * - `removeBrowserContainer`: removes it with its session.
 *
 * Key construct:
 * - Browser tools run `agent-browser` here, never in the container of the model's Bash: there the
 *   DevTools port on 127.0.0.1 and the daemon socket let any process drive the logged-in browser
 *   past the confirmation gate (security review and Codex security scan, 5 October 2026). The
 *   companion takes the workspace mounts of the session's container, so a screenshot written to
 *   /workspace/<scope>/shots is the same file the tools read; its state directory sits beside the
 *   tool environment, which is all Bash sees of the tools volume.
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";

import type Docker from "dockerode";

import { dockerStatus, inspectContainer, requireRunningContainer } from "./docker-sandbox-container.js";
import { sandboxContainerName } from "./docker-sandbox-lifecycle.js";
import {
  browserStateSubpath,
  buildBrowserContainerOptions,
  SANDBOX_CONTAINER_POLICY_VERSION,
  type SandboxDockerRuntime,
} from "./docker-sandbox-options.js";

const POLICY_LABEL = "dev.osinara.sandbox.policy-version";
const EVE_SESSION_LABEL = "dev.osinara.sandbox.eve-session-id";
/** Restore files of the logged-in session `osinara` (agent-browser names them `<session>-<restore>`). */
const LOGGED_IN_STATE_PREFIX = "osinara-osinara";

export function sandboxBrowserContainerName(sessionId: string): string {
  return `${sandboxContainerName(sessionId)}-browser`;
}

/**
 * Moves the restore state of the logged-in session from the tool environment (mounted into Bash)
 * to the browser state directory, unless the browser already has its own. Logins survive the move
 * and stop being readable from Bash.
 */
export async function migrateBrowserState(toolsRoot: string, workspaceId: string): Promise<number> {
  const from = `${toolsRoot}/${workspaceId}/home/.agent-browser/sessions`;
  const to = `${toolsRoot}/${browserStateSubpath(workspaceId)}/home/.agent-browser/sessions`;
  await mkdir(to, { recursive: true });
  const existing = await readdir(to);
  let names: string[];
  try {
    names = await readdir(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const moving = names.filter((name) => name.startsWith(LOGGED_IN_STATE_PREFIX));
  if (moving.length === 0) return 0;
  // The browser's own state wins; an older copy left in the tool environment is removed anyway,
  // so Bash never keeps a readable login.
  const keep = existing.some((name) => name.startsWith(LOGGED_IN_STATE_PREFIX));
  for (const name of moving) {
    if (keep) await rm(`${from}/${name}`, { force: true });
    else await rename(`${from}/${name}`, `${to}/${name}`);
  }
  console.info(JSON.stringify({ code: "AGENT_SANDBOX_RUNNER_BROWSER_STATE_MOVED", files: moving.length, kept: keep }));
  return moving.length;
}

export async function removeBrowserContainer(docker: Docker, sessionId: string): Promise<void> {
  const existing = await inspectContainer(docker, sessionId, sandboxBrowserContainerName(sessionId));
  if (!existing) return;
  await existing.container.remove({ force: true, v: true }).catch((error) => {
    if (dockerStatus(error) !== 404) throw error;
  });
}

/**
 * The session's running browser companion. It is created from the session's own container (its
 * workspace mounts and tool workspace), which must exist and be trusted; one from an older policy
 * is replaced. Starting goes through the engine's capacity gate.
 */
export async function requireBrowserContainer(input: {
  activeOperations: number;
  docker: Docker;
  gateStart: (start: () => Promise<void>) => Promise<void>;
  runtime: SandboxDockerRuntime;
  sessionId: string;
  toolsRoot: string;
}): Promise<Docker.Container> {
  const session = await inspectContainer(input.docker, input.sessionId);
  if (!session) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_FOUND: Sandbox is absent");
  const sessionMounts = (session.inspection.HostConfig.Mounts ?? []) as Array<Docker.MountSettings & {
    VolumeOptions?: { Subpath?: string };
  }>;
  const toolsMount = sessionMounts.find((mount) => mount.Target.startsWith("/tools/"));
  const toolsWorkspaceId = toolsMount?.VolumeOptions?.Subpath;
  if (!toolsWorkspaceId) {
    throw new Error("AGENT_SANDBOX_RUNNER_BROWSER_UNAVAILABLE: The browser runs only beside a trusted sandbox");
  }
  const name = sandboxBrowserContainerName(input.sessionId);
  const existing = await inspectContainer(input.docker, input.sessionId, name);
  if (existing && existing.inspection.Config.Labels?.[POLICY_LABEL] !== SANDBOX_CONTAINER_POLICY_VERSION) {
    await existing.container.remove({ force: true, v: true });
  } else if (existing) {
    const { container } = await requireRunningContainer(
      input.docker,
      input.sessionId,
      input.activeOperations,
      input.gateStart,
      name,
    );
    return container;
  }
  await migrateBrowserState(input.toolsRoot, toolsWorkspaceId);
  await mkdir(`${input.toolsRoot}/${browserStateSubpath(toolsWorkspaceId)}/home`, { recursive: true });
  const options = buildBrowserContainerOptions(input.runtime, {
    eveSessionId: session.inspection.Config.Labels?.[EVE_SESSION_LABEL] ?? "",
    sandboxSessionId: input.sessionId,
    toolsWorkspaceId,
    workspaceMounts: sessionMounts
      .filter((mount) => mount.Target.startsWith("/workspace/") && mount.VolumeOptions?.Subpath)
      .map((mount) => ({ mountPoint: mount.Target.slice("/workspace/".length), workspaceId: mount.VolumeOptions!.Subpath! })),
  });
  options.name = name;
  const container = await input.docker.createContainer(options);
  try {
    await input.gateStart(() => container.start());
  } catch (error) {
    await container.remove({ force: true, v: true }).catch(() => undefined);
    throw error;
  }
  return container;
}
