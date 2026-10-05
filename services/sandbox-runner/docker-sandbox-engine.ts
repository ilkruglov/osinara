/**
 * Docker-backed implementation of the private sandbox runner engine.
 *
 * Exports:
 * - `buildSandboxContainerOptions`: re-exported pure container policy builder.
 * - `createDockerSandboxEngine`: durable scoped container lifecycle and I/O.
 * - `resolveSandboxRuntimeImage`: requires the exact sandbox runtime image identity.
 * - `resolveSandboxDockerRuntime`: discovers Compose-owned volumes/network fail-fast.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { posix } from "node:path";

import Docker from "dockerode";

import { WORKSPACE_MAX_FILE_BYTES } from "../../agent/config.js";

import {
  SANDBOX_RUNNER_MAX_OUTPUT_BYTES,
  SANDBOX_RUNNER_TIMEOUT_MAX_MS,
  type SandboxRunnerCreateRequest,
  type SandboxRunnerRemovePathRequest,
  type SandboxRunnerSessionResponse,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import type { SandboxEngine } from "./sandbox-engine.js";
import { createSandboxWriteMemo, isSkillPackagePath } from "./sandbox-write-memo.js";
import {
  collectLimitedStream,
} from "./docker-sandbox-files.js";
import {
  assertShellSafePath,
  initializeToolEnvironmentCommand,
} from "./docker-sandbox-commands.js";
import {
  dockerStatus,
  inspectContainer,
  requireRunningContainer,
} from "./docker-sandbox-container.js";
import { executeSandboxProcess, processTimedOut } from "./docker-sandbox-process.js";
import {
  createSandboxRepeatGuard,
  SANDBOX_REPEAT_REFUSED_EXIT_CODE,
  SANDBOX_REPEAT_REFUSED_MESSAGE,
  sandboxCommandFingerprint,
} from "./sandbox-repeat-guard.js";
import {
  createSandboxActivityRegistry,
  SANDBOX_CAPACITY_MIN_IDLE_MS,
  SANDBOX_IDLE_TIMEOUT_MS,
  SANDBOX_MAX_RUNNING_CONTAINERS,
  sandboxContainerName,
  sandboxContainerNeedsReplacement,
  sandboxRequestHash,
} from "./docker-sandbox-lifecycle.js";

import { makeRoomForContainer, reconcileSandboxContainers } from "./docker-sandbox-reconciliation.js";
import { readContainerFile, writeContainerFile, writeSeedFiles } from "./docker-sandbox-transfer.js";
import {
  browserStateSubpath,
  buildSandboxContainerOptions,
  resolveTrustedToolMount,
  type SandboxDockerRuntime,
} from "./docker-sandbox-options.js";
import { migrateBrowserState, removeBrowserContainer, requireBrowserContainer } from "./docker-sandbox-browser.js";
import {
  isCleanupCommand,
  SANDBOX_CLEANUP_PATH,
  SANDBOX_QUOTA_REFUSED_EXIT_CODE,
  type SandboxDiskQuota,
  type WorkspaceDirectories,
} from "./sandbox-disk-quota.js";
import { executeGoogleWorkspaceContainer } from "./google-workspace-container.js";

export { buildSandboxContainerOptions } from "./docker-sandbox-options.js";

/** The largest skill package file that may be written past a refusal; real ones are a few KiB. */
const SKILL_PACKAGE_FILE_EXEMPT_BYTES = 256 * 1024;
/** All skill package bytes one container run may write past a refusal. */
const SKILL_PACKAGE_RUN_EXEMPT_BYTES = 2 * 1024 * 1024;
/** Where Eve materializes skill packages: the skills folder of HOME, nowhere in a workspace. */
const HOME_SKILLS_PATH = /^(?:\/tools\/[^/]+\/home|\/tmp\/home)\/\.agents\/skills\//u;

const MOUNT_TOOLS_DESTINATION = "/runner/tools";
const MOUNT_WORKSPACES_DESTINATION = "/runner/workspaces";
const SANDBOX_NETWORK_LABEL = "sandbox-egress";
const SANDBOX_SESSION_LABEL = "dev.osinara.sandbox.session-id";
const SANDBOX_PROJECT_LABEL = "dev.osinara.sandbox.project";
const SANDBOX_REQUEST_HASH_LABEL = "dev.osinara.sandbox.request-hash";
const GOOGLE_WORKSPACE_EXECUTION_LABEL = "dev.osinara.google-workspace-execution";

interface RunnerMount {
  Destination?: string;
  Name?: string;
}

interface RuntimeRoots {
  toolsRoot: string;
  workspaceRoot: string;
}

export function resolveSandboxRuntimeImage(): string {
  const image = process.env.SANDBOX_RUNTIME_IMAGE;
  if (!image) {
    throw new Error(
      "AGENT_SANDBOX_RUNTIME_IMAGE_MISSING: Не задан обязательный образ sandbox runtime",
    );
  }
  return image;
}


function resolvePath(path: string): string {
  assertShellSafePath(path);
  const normalized = path.startsWith("/") ? posix.normalize(path) : posix.resolve("/workspace", path);
  const allowed = ["/tmp", "/tools", "/workspace"].some((root) =>
    normalized === root || normalized.startsWith(`${root}/`)
  );
  if (!allowed) {
    throw new Error("AGENT_SANDBOX_RUNNER_PATH_INVALID: Path is outside sandbox writable roots");
  }
  return normalized;
}

async function requireDirectory(path: string, code: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${code}: Required path is not a directory`);
}

async function ensureToolDirectories(
  docker: Docker,
  container: Docker.Container,
  request: SandboxRunnerCreateRequest,
): Promise<void> {
  if (request.access !== "trusted") return;
  const mount = resolveTrustedToolMount(request.mounts);
  const root = `/tools/${mount.mountPoint}`;
  const directories = [`${root}/bin`, `${root}/cache`, `${root}/home`, `${root}/npm`];
  const python = `${root}/python`;
  const command = initializeToolEnvironmentCommand({ directories, pythonRoot: python });
  const result = await executeSandboxProcess(docker, container, {
    command,
    timeoutMs: SANDBOX_RUNNER_TIMEOUT_MAX_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_TOOL_ENV_INIT_FAILED: ${result.stderr}`);
  }
}

/**
 * The workspaces one session writes to, each with every directory that belongs to it: its files,
 * its tool environment and its browser state. The set does not depend on which session asks, so
 * a family workspace measured from a private chat is the same number as from the family group.
 */
function sessionWorkspaces(inspection: Docker.ContainerInspectInfo, roots: RuntimeRoots): WorkspaceDirectories[] {
  const ids = new Set<string>();
  for (const mount of (inspection.HostConfig.Mounts ?? []) as Array<Docker.MountSettings & { VolumeOptions?: { Subpath?: string } }>) {
    const id = mount.VolumeOptions?.Subpath;
    if (id && (mount.Target.startsWith("/workspace/") || mount.Target.startsWith("/tools/"))) ids.add(id);
  }
  return [...ids].map((id) => ({
    directories: [`${roots.workspaceRoot}/${id}`, `${roots.toolsRoot}/${id}`, `${roots.toolsRoot}/${browserStateSubpath(id)}`],
    key: id,
  }));
}

export function createDockerSandboxEngine(input: {
  /** Workspace budget and host free-space floor; absent in tests that do not exercise it. */
  diskQuota?: SandboxDiskQuota;
  docker: Docker;
  /** Running-container cap; the configured value unless a test narrows it. */
  limits?: { maxRunningContainers: number };
  roots: RuntimeRoots;
  runtime: SandboxDockerRuntime;
}): SandboxEngine {
  const activity = createSandboxActivityRegistry(Date.now);
  const repeatGuard = createSandboxRepeatGuard(Date.now);
  const writeMemo = createSandboxWriteMemo();
  // Every container start, a new one or a stopped one resuming, passes through one gate: the
  // room check and the start are one step, so two sessions cannot both take the last slot
  // (Codex review, 5 October 2026).
  let capacityGate: Promise<unknown> = Promise.resolve();
  const withCapacity = async <T>(sessionId: string, start: () => Promise<T>): Promise<T> => {
    const turn = capacityGate.then(async () => {
      const capacity = await makeRoomForContainer({
        activity,
        docker: input.docker,
        exceptSessionId: sessionId,
        limit: input.limits?.maxRunningContainers ?? SANDBOX_MAX_RUNNING_CONTAINERS,
        minIdleMs: SANDBOX_CAPACITY_MIN_IDLE_MS,
        nowMs: Date.now(),
        project: input.runtime.project,
      });
      if (!capacity.room) {
        throw new Error(
          `AGENT_SANDBOX_RUNNER_CAPACITY_EXHAUSTED: All ${capacity.running} sandbox containers are in use`,
        );
      }
      return await start();
    });
    capacityGate = turn.catch(() => undefined);
    return await turn;
  };

  // Skill package writes skip the disk budget only within these bounds: the path alone does not
  // prove the framework wrote it, and a model writing there may not grow without limit.
  const skillExemptBytes = new Map<string, number>();
  const skillWriteExempt = (generation: string | null, path: string, bytes: number): boolean => {
    if (generation === null || !isSkillPackagePath(path) || !HOME_SKILLS_PATH.test(path)) return false;
    if (bytes > SKILL_PACKAGE_FILE_EXEMPT_BYTES) return false;
    const spent = (skillExemptBytes.get(generation) ?? 0) + bytes;
    if (spent > SKILL_PACKAGE_RUN_EXEMPT_BYTES) return false;
    if (skillExemptBytes.size > 1_000) skillExemptBytes.clear();
    skillExemptBytes.set(generation, spent);
    return true;
  };

  return {
    async health() {
      await input.docker.ping();
      await input.docker.getImage(input.runtime.image).inspect();
    },
    async createSession(request): Promise<SandboxRunnerSessionResponse> {
      const sessionId = request.sandboxSessionId;
      return await activity.runExclusive(sessionId, () => activity.runActive(sessionId, async () => {
        for (const mount of request.mounts) {
          await mkdir(`${input.roots.workspaceRoot}/${mount.workspaceId}`, { recursive: true });
          await requireDirectory(
            `${input.roots.workspaceRoot}/${mount.workspaceId}`,
            "AGENT_SANDBOX_RUNNER_WORKSPACE_MISSING",
          );
        }
        if (request.access === "trusted") {
          // Exactly one verified scope owns HOME and the read-only Google profile mount.
          const toolMount = resolveTrustedToolMount(request.mounts);
          const toolsPath = `${input.roots.toolsRoot}/${toolMount.workspaceId}`;
          await mkdir(toolsPath, { recursive: true });
          await requireDirectory(toolsPath, "AGENT_SANDBOX_RUNNER_TOOLS_MISSING");
        }

        let existing = await inspectContainer(input.docker, sessionId);
        const labels = existing?.inspection.Config.Labels;
        const expectedBrowserlessKey = request.access === "trusted" && input.runtime.browserlessApiKey
          ? `BROWSERLESS_API_KEY=${input.runtime.browserlessApiKey}`
          : undefined;
        const existingBrowserlessKey = existing?.inspection.Config.Env?.find((entry) =>
          entry.startsWith("BROWSERLESS_API_KEY=")
        );
        if (existing && (existingBrowserlessKey !== expectedBrowserlessKey || sandboxContainerNeedsReplacement({
          requestHash: labels?.[SANDBOX_REQUEST_HASH_LABEL],
          sandboxSessionId: labels?.[SANDBOX_SESSION_LABEL],
        }, request))) {
          if (request.seedFiles === undefined) {
            return { created: false, seedRequired: true, sessionId };
          }
          // Workspace and tools are named-volume subpaths, so stale compute is disposable. The
          // browser companion copied this container's mounts, so it goes too.
          await existing.container.remove({ force: true, v: true });
          await removeBrowserContainer(input.docker, sessionId);
          existing = null;
        }
        if (existing) {
          const stopped = existing;
          if (!stopped.inspection.State.Running) {
            await withCapacity(sessionId, () => stopped.container.start());
          }
          return { created: false, seedRequired: false, sessionId };
        }
        if (request.seedFiles === undefined) {
          return { created: false, seedRequired: true, sessionId };
        }

        const seedFiles = request.seedFiles;
        // A companion left from an earlier container of this session belongs to that one.
        await removeBrowserContainer(input.docker, sessionId);
        if (request.access === "trusted") {
          // No container of the session runs now, so Bash cannot read the logged-in state while
          // it leaves the tool environment.
          await migrateBrowserState(input.roots.toolsRoot, resolveTrustedToolMount(request.mounts).workspaceId);
        }
        const options = buildSandboxContainerOptions(input.runtime, request);
        options.name = sandboxContainerName(sessionId);
        options.Labels = {
          ...options.Labels,
          [SANDBOX_REQUEST_HASH_LABEL]: sandboxRequestHash(request),
        };
        await withCapacity(sessionId, async () => {
          const container = await input.docker.createContainer(options);
          try {
            await container.start();
            await ensureToolDirectories(input.docker, container, request);
            await writeSeedFiles(input.docker, container, seedFiles);
          } catch (error) {
            await container.remove({ force: true, v: true }).catch(() => undefined);
            throw error;
          }
        });
        return { created: true, seedRequired: false, sessionId };
      }));
    },
    async runProcess(sessionId, request, signal) {
      if (request.target === "browser") {
        // Browser tools only: bounded commands of the application, not the model's Bash, so the
        // repeat guard (a model retrying a timed-out command) does not apply.
        return await activity.runActive(sessionId, async () => {
          // The session's creation lock: creating the companion cannot interleave with the
          // session's container being created, replaced or stopped.
          const container = await activity.runExclusive(sessionId, () => requireBrowserContainer({
            activeOperations: activity.activeCount(sessionId),
            docker: input.docker,
            gateStart: (start) => withCapacity(sessionId, start),
            runtime: input.runtime,
            sessionId,
            toolsRoot: input.roots.toolsRoot,
          }));
          const { target: _target, ...processRequest } = request;
          return await executeSandboxProcess(input.docker, container, processRequest, signal);
        });
      }
      return await activity.runActive(sessionId, async () => {
        const processRequest = request.workingDirectory
          ? { ...request, workingDirectory: resolvePath(request.workingDirectory) }
          : request;
        const fingerprint = sandboxCommandFingerprint(
          processRequest.command,
          processRequest.workingDirectory,
        );
        if (repeatGuard.refuses(sessionId, fingerprint)) {
          console.error(JSON.stringify({
            code: "AGENT_SANDBOX_RUNNER_REPEAT_REFUSED",
            sessionId,
          }));
          return {
            exitCode: SANDBOX_REPEAT_REFUSED_EXIT_CODE,
            processId: randomUUID(),
            stderr: SANDBOX_REPEAT_REFUSED_MESSAGE,
            stdout: "",
          };
        }
        const { container, inspection } = await requireRunningContainer(input.docker, sessionId, activity.activeCount(sessionId), (start) => withCapacity(sessionId, start));
        const refusal = await input.diskQuota?.refusal(sessionWorkspaces(inspection, input.roots));
        let allowed = processRequest;
        if (refusal) {
          if (!isCleanupCommand(processRequest.command)) {
            console.error(JSON.stringify({ code: refusal.slice(0, refusal.indexOf(":")), sessionId }));
            return { exitCode: SANDBOX_QUOTA_REFUSED_EXIT_CODE, processId: randomUUID(), stderr: refusal, stdout: "" };
          }
          // Past a refusal only the system's own rm/ls/du/df/find run, not ones planted in PATH.
          allowed = { ...processRequest, environment: { ...processRequest.environment, PATH: SANDBOX_CLEANUP_PATH } };
        }
        const result = await executeSandboxProcess(input.docker, container, allowed, signal);
        if (processTimedOut(result)) repeatGuard.recordTimeout(sessionId, fingerprint);
        return result;
      });
    },
    async runGoogleWorkspace(request, signal) {
      return await executeGoogleWorkspaceContainer({
        docker: input.docker,
        request,
        runtime: input.runtime,
        signal,
      });
    },
    async readFile(sessionId, path) {
      return await activity.runActive(sessionId, async () => {
        const { container } = await requireRunningContainer(input.docker, sessionId, activity.activeCount(sessionId), (start) => withCapacity(sessionId, start));
        // Through the stdout of a process in the container: the archive API reads neither the
        // read-only root nor a tmpfs HOME, and nothing is staged where the model could swap it.
        return await readContainerFile(input.docker, container, resolvePath(path), WORKSPACE_MAX_FILE_BYTES);
      });
    },
    async writeFile(sessionId, path, content) {
      await activity.runActive(sessionId, async () => {
        const { container, generation, inspection } = await requireRunningContainer(
          input.docker,
          sessionId,
          activity.activeCount(sessionId),
        );
        const resolved = resolvePath(path);
        // Every file the model writes, wherever. Skill package files are the framework's, small and
        // rewritten every turn, and refusing them would stop every turn of the workspace, cleanup
        // included; but the path alone proves nothing (a model can write there too), so only a
        // small file passes on its name (Codex review, 5 October 2026).
        // Eve rewrites every dynamic skill package on every turn without diffing it; identical
        // bytes already inside this container run are that same materialization, not a new one,
        // and spend nothing of the disk budget or of its skill allowance.
        if (writeMemo.hasSkillFile(generation, resolved, content)) return;
        const refusal = await input.diskQuota?.refusal(sessionWorkspaces(inspection, input.roots));
        if (refusal && !skillWriteExempt(generation, resolved, content.byteLength)) throw new Error(refusal);
        // Through the stdin of a process in the container, renamed into place there: nothing is
        // staged where the model's Bash could replace it between upload and move.
        await writeContainerFile(input.docker, container, resolved, content);
        writeMemo.rememberSkillFile(generation, resolved, content);
      });
    },
    async removePath(sessionId, request: SandboxRunnerRemovePathRequest) {
      await activity.runActive(sessionId, async () => {
        const { container } = await requireRunningContainer(input.docker, sessionId, activity.activeCount(sessionId), (start) => withCapacity(sessionId, start));
        const args = ["rm"];
        if (request.force) args.push("-f");
        if (request.recursive) args.push("-r");
        args.push("--", resolvePath(request.path));
        const exec = await container.exec({
          AttachStderr: true,
          AttachStdout: true,
          Cmd: args,
          Tty: false,
        });
        await collectLimitedStream(await exec.start({ Tty: false }), SANDBOX_RUNNER_MAX_OUTPUT_BYTES);
        const inspection = await exec.inspect();
        if (inspection.ExitCode !== 0) {
          throw new Error("AGENT_SANDBOX_RUNNER_REMOVE_FAILED: Could not remove sandbox path");
        }
      });
    },
    async stopSession(sessionId) {
      // In the creation lock, so a companion being created cannot start after this returns.
      await activity.runExclusive(sessionId, async () => {
        const existing = await inspectContainer(input.docker, sessionId);
        if (existing) {
          await existing.container.remove({ force: true, v: true }).catch((error) => {
            if (dockerStatus(error) !== 404) throw error;
          });
        }
        await removeBrowserContainer(input.docker, sessionId);
      });
      activity.forget(sessionId);
      repeatGuard.forget(sessionId);
    },
    async reconcileIdleSessions(now) {
      const cutoffMs = now.getTime() - SANDBOX_IDLE_TIMEOUT_MS;
      return await reconcileSandboxContainers({
        activity,
        docker: input.docker,
        idleCutoffMs: cutoffMs,
        nowMs: now.getTime(),
        project: input.runtime.project,
      });
    },
    async stopAllSessions() {
      const containers = await input.docker.listContainers({
        all: true,
        filters: {
          label: [`${SANDBOX_PROJECT_LABEL}=${input.runtime.project}`],
        },
      });
      const owned = containers.filter((item) =>
        item.Labels[SANDBOX_SESSION_LABEL] !== undefined ||
        item.Labels[GOOGLE_WORKSPACE_EXECUTION_LABEL] === "true"
      );
      await Promise.all(owned.map(async (item) => {
        await input.docker.getContainer(item.Id).remove({ force: true, v: true }).catch((error) => {
          if (dockerStatus(error) !== 404) throw error;
        });
      }));
      activity.clear();
    },
    async deleteToolEnvironment(workspaceId) {
      await rm(`${input.roots.toolsRoot}/${workspaceId}`, { force: true, recursive: true });
      await rm(`${input.roots.toolsRoot}/${browserStateSubpath(workspaceId)}`, { force: true, recursive: true });
    },
  };
}

export async function resolveSandboxDockerRuntime(docker: Docker): Promise<{
  roots: RuntimeRoots;
  runtime: SandboxDockerRuntime;
}> {
  // Configuration is validated before any Docker call so startup fails with one stable diagnosis.
  const image = resolveSandboxRuntimeImage();
  const runnerId = process.env.HOSTNAME;
  if (!runnerId) throw new Error("AGENT_SANDBOX_RUNNER_HOSTNAME_MISSING: Container ID is required");
  const inspection = await docker.getContainer(runnerId).inspect();
  const mounts = inspection.Mounts as RunnerMount[];
  const workspaceVolume = mounts.find((mount) => mount.Destination === MOUNT_WORKSPACES_DESTINATION)?.Name;
  const toolsVolume = mounts.find((mount) => mount.Destination === MOUNT_TOOLS_DESTINATION)?.Name;
  if (!workspaceVolume || !toolsVolume) {
    throw new Error("AGENT_SANDBOX_RUNNER_VOLUME_MISSING: Compose volumes are not mounted");
  }

  const composeProject = inspection.Config.Labels?.["com.docker.compose.project"];
  if (!composeProject) {
    throw new Error("AGENT_SANDBOX_RUNNER_PROJECT_MISSING: Compose project label is absent");
  }
  const networks = await docker.listNetworks({
    filters: {
      label: [
        `com.docker.compose.network=${SANDBOX_NETWORK_LABEL}`,
        `com.docker.compose.project=${composeProject}`,
      ],
    },
  });
  const egressNetwork = networks.length === 1 ? networks[0]!.Name : null;
  if (!egressNetwork) {
    throw new Error("AGENT_SANDBOX_RUNNER_NETWORK_MISSING: Egress network is not uniquely resolved");
  }

  return {
    roots: {
      toolsRoot: MOUNT_TOOLS_DESTINATION,
      workspaceRoot: MOUNT_WORKSPACES_DESTINATION,
    },
    runtime: {
      browserlessApiKey: process.env.BROWSERLESS_API_KEY?.trim() || undefined,
      egressNetwork,
      image,
      project: composeProject,
      toolsVolume,
      workspaceVolume,
    },
  };
}
