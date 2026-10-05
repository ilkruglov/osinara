/**
 * The browser companion container of a trusted sandbox session.
 *
 * Exports:
 * - `sandboxBrowserContainerName`: the companion's deterministic name.
 * - `migrateBrowserState`: once per tool workspace, moves the logged-in session's restore state
 *   out of the tool environment Bash mounts and deletes what is left of it there.
 * - `requireBrowserContainer`: the running companion of the session's current container.
 * - `removeBrowserContainer`: removes it with its session.
 *
 * Key construct:
 * - Browser tools run `agent-browser` here, never in the container of the model's Bash: there the
 *   DevTools port on 127.0.0.1 and the daemon socket let any process drive the logged-in browser
 *   past the confirmation gate (security review and Codex security scan, 5 October 2026). The
 *   companion mounts only its state directory, which sits beside the tool environment (all Bash
 *   sees of the tools volume), and has no workspace: screenshots go through the application.
 * - The restore state leaves the tool environment before any Bash of the new layout runs: the
 *   engine migrates while creating the session's container, when no container of the session is
 *   running, and only once per workspace (a marker), so files Bash writes later under those names
 *   are never imported into the logged-in browser.
 */
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";

import type Docker from "dockerode";

import { dockerStatus, inspectContainer, requireRunningContainer } from "./docker-sandbox-container.js";
import { sandboxContainerName } from "./docker-sandbox-lifecycle.js";
import {
  browserStateSubpath,
  buildBrowserContainerOptions,
  SANDBOX_CONTAINER_POLICY_VERSION,
  SANDBOX_PARENT_LABEL,
  type SandboxDockerRuntime,
} from "./docker-sandbox-options.js";

const POLICY_LABEL = "dev.osinara.sandbox.policy-version";
const EVE_SESSION_LABEL = "dev.osinara.sandbox.eve-session-id";
/** Files of the logged-in session `osinara`: `<session>-<restore>.json` and its autosave candidates. */
const LOGGED_IN_STATE_PREFIX = "osinara-osinara";
const RESTORE_FILE = `${LOGGED_IN_STATE_PREFIX}.json`;
const MIGRATED_MARKER = ".state-moved-from-tools";

export function sandboxBrowserContainerName(sessionId: string): string {
  return `${sandboxContainerName(sessionId)}-browser`;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Regular files of `directory` named with the logged-in prefix; none when it is missing. */
async function stateFiles(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const name of names) {
    if (name.startsWith(LOGGED_IN_STATE_PREFIX) && await isRegularFile(`${directory}/${name}`)) files.push(name);
  }
  return files;
}

/**
 * Moves the restore file of the logged-in session to the browser state directory unless the
 * browser already has one, then deletes every logged-in file left in the tool environment
 * (autosave candidates under `.tmp` included). Runs only while no container of the session is
 * running; a path through a link planted by Bash is not followed, the files there are deleted only.
 */
export async function migrateBrowserState(toolsRoot: string, workspaceId: string): Promise<void> {
  const destination = `${toolsRoot}/${browserStateSubpath(workspaceId)}/home/.agent-browser/sessions`;
  const marker = `${toolsRoot}/${browserStateSubpath(workspaceId)}/${MIGRATED_MARKER}`;
  await mkdir(destination, { recursive: true });
  if (await isRegularFile(marker)) return;
  const source = `${toolsRoot}/${workspaceId}/home/.agent-browser/sessions`;
  let sourceIsReal = false;
  try {
    sourceIsReal = await realpath(source) === source;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let moved = 0;
  let removed = 0;
  if (sourceIsReal) {
    const keepOwn = await isRegularFile(`${destination}/${RESTORE_FILE}`);
    for (const name of await stateFiles(source)) {
      if (!keepOwn && name === RESTORE_FILE) {
        await rename(`${source}/${name}`, `${destination}/${name}`);
        moved += 1;
      } else {
        await rm(`${source}/${name}`, { force: true });
        removed += 1;
      }
    }
    for (const name of await stateFiles(`${source}/.tmp`)) {
      await rm(`${source}/.tmp/${name}`, { force: true });
      removed += 1;
    }
  }
  await writeFile(marker, `${new Date().toISOString()}\n`);
  console.info(JSON.stringify({ code: "AGENT_SANDBOX_RUNNER_BROWSER_STATE_MOVED", moved, removed, sourceIsReal }));
}

export async function removeBrowserContainer(docker: Docker, sessionId: string): Promise<void> {
  const existing = await inspectContainer(docker, sessionId, sandboxBrowserContainerName(sessionId));
  if (!existing) return;
  await existing.container.remove({ force: true, v: true }).catch((error) => {
    if (dockerStatus(error) !== 404) throw error;
  });
}

/**
 * The session's running browser companion, for the session's current trusted container. A
 * companion of an earlier container of the session or of an older policy is replaced. The caller
 * holds the session's creation lock, so creating it cannot interleave with the session's
 * container being replaced or stopped; starting goes through the engine's capacity gate.
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
  const toolsWorkspaceId = sessionMounts.find((mount) => mount.Target.startsWith("/tools/"))?.VolumeOptions?.Subpath;
  if (!toolsWorkspaceId) {
    throw new Error("AGENT_SANDBOX_RUNNER_BROWSER_UNAVAILABLE: The browser runs only beside a trusted sandbox");
  }
  const name = sandboxBrowserContainerName(input.sessionId);
  const existing = await inspectContainer(input.docker, input.sessionId, name);
  const labels = existing?.inspection.Config.Labels;
  if (existing && (labels?.[POLICY_LABEL] !== SANDBOX_CONTAINER_POLICY_VERSION ||
    labels?.[SANDBOX_PARENT_LABEL] !== session.inspection.Id)) {
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
  await mkdir(`${input.toolsRoot}/${browserStateSubpath(toolsWorkspaceId)}/home`, { recursive: true });
  const options = buildBrowserContainerOptions(input.runtime, {
    eveSessionId: session.inspection.Config.Labels?.[EVE_SESSION_LABEL] ?? "",
    parentContainerId: session.inspection.Id,
    sandboxSessionId: input.sessionId,
    toolsWorkspaceId,
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
