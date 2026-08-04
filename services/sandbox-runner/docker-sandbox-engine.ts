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

import {
  SANDBOX_RUNNER_MAX_OUTPUT_BYTES,
  SANDBOX_RUNNER_TIMEOUT_MAX_MS,
  type SandboxRunnerCreateRequest,
  type SandboxRunnerRemovePathRequest,
  type SandboxRunnerSessionResponse,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";
import type { SandboxEngine } from "./sandbox-engine.js";
import {
  collectLimitedStream,
  readSingleFileArchive,
  writeSingleFileArchive,
} from "./docker-sandbox-files.js";
import { executeSandboxProcess } from "./docker-sandbox-process.js";
import {
  createSandboxActivityRegistry,
  SANDBOX_IDLE_TIMEOUT_MS,
  sandboxContainerName,
  sandboxContainerNeedsReplacement,
  sandboxRequestHash,
} from "./docker-sandbox-lifecycle.js";

import { reconcileSandboxContainers } from "./docker-sandbox-reconciliation.js";
import { writeSandboxSeedArchive } from "./docker-sandbox-seed.js";
import {
  buildSandboxContainerOptions,
  resolveTrustedToolMount,
  type SandboxDockerRuntime,
} from "./docker-sandbox-options.js";

export { buildSandboxContainerOptions } from "./docker-sandbox-options.js";

const FILE_UPLOAD_STAGING_DIRECTORY = "/.osinara-sandbox-uploads";
const FILE_MISSING_EXIT_CODE = 44;
const MOUNT_TOOLS_DESTINATION = "/runner/tools";
const MOUNT_WORKSPACES_DESTINATION = "/runner/workspaces";
const MOUNT_GOOGLE_WORKSPACE_CREDENTIALS_DESTINATION = "/runner/google-workspace-credentials";
const SANDBOX_NETWORK_LABEL = "sandbox-egress";
const SANDBOX_SESSION_LABEL = "dev.osinara.sandbox.session-id";
const SANDBOX_PROJECT_LABEL = "dev.osinara.sandbox.project";
const SANDBOX_REQUEST_HASH_LABEL = "dev.osinara.sandbox.request-hash";

interface RunnerMount {
  Destination?: string;
  Name?: string;
}

interface RuntimeRoots {
  googleWorkspaceCredentialsRoot: string;
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

function dockerStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

function resolvePath(path: string): string {
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
  const command = [
    `mkdir -p ${directories.map((path) => JSON.stringify(path)).join(" ")}`,
    `(test -x ${JSON.stringify(`${python}/bin/python`)} || python3 -m venv ${JSON.stringify(python)})`,
  ].join(" && ");
  const result = await executeSandboxProcess(docker, container, {
    command,
    timeoutMs: SANDBOX_RUNNER_TIMEOUT_MAX_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_TOOL_ENV_INIT_FAILED: ${result.stderr}`);
  }
}

async function inspectContainer(
  docker: Docker,
  sessionId: string,
): Promise<{ container: Docker.Container; inspection: Docker.ContainerInspectInfo } | null> {
  const container = docker.getContainer(sandboxContainerName(sessionId));
  try {
    return { container, inspection: await container.inspect() };
  } catch (error) {
    if (dockerStatus(error) === 404) return null;
    throw error;
  }
}

async function requireRunningContainer(docker: Docker, sessionId: string): Promise<Docker.Container> {
  const existing = await inspectContainer(docker, sessionId);
  if (!existing) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_FOUND: Sandbox is absent");
  if (!existing.inspection.State.Running) await existing.container.start();
  return existing.container;
}

export function createDockerSandboxEngine(input: {
  docker: Docker;
  roots: RuntimeRoots;
  runtime: SandboxDockerRuntime;
}): SandboxEngine {
  const activity = createSandboxActivityRegistry(Date.now);

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
          const googleCredentialsPath =
            `${input.roots.googleWorkspaceCredentialsRoot}/${toolMount.workspaceId}`;
          await mkdir(toolsPath, { recursive: true });
          await mkdir(googleCredentialsPath, { recursive: true });
          await requireDirectory(toolsPath, "AGENT_SANDBOX_RUNNER_TOOLS_MISSING");
          await requireDirectory(
            googleCredentialsPath,
            "AGENT_SANDBOX_RUNNER_GOOGLE_CREDENTIALS_MISSING",
          );
        }

        let existing = await inspectContainer(input.docker, sessionId);
        const labels = existing?.inspection.Config.Labels;
        if (existing && sandboxContainerNeedsReplacement({
          requestHash: labels?.[SANDBOX_REQUEST_HASH_LABEL],
          sandboxSessionId: labels?.[SANDBOX_SESSION_LABEL],
        }, request)) {
          if (request.seedFiles === undefined) {
            return { created: false, seedRequired: true, sessionId };
          }
          // Workspace and tools are named-volume subpaths, so stale compute is disposable.
          await existing.container.remove({ force: true, v: true });
          existing = null;
        }
        if (existing) {
          if (!existing.inspection.State.Running) await existing.container.start();
          return { created: false, seedRequired: false, sessionId };
        }
        if (request.seedFiles === undefined) {
          return { created: false, seedRequired: true, sessionId };
        }

        const options = buildSandboxContainerOptions(input.runtime, request);
        options.name = sandboxContainerName(sessionId);
        options.Labels = {
          ...options.Labels,
          [SANDBOX_REQUEST_HASH_LABEL]: sandboxRequestHash(request),
        };
        const container = await input.docker.createContainer(options);
        try {
          await container.start();
          await ensureToolDirectories(input.docker, container, request);
          await writeSandboxSeedArchive(container, request.seedFiles);
        } catch (error) {
          await container.remove({ force: true, v: true }).catch(() => undefined);
          throw error;
        }
        return { created: true, seedRequired: false, sessionId };
      }));
    },
    async runProcess(sessionId, request, signal) {
      return await activity.runActive(sessionId, async () => {
        const container = await requireRunningContainer(input.docker, sessionId);
        const processRequest = request.workingDirectory
          ? { ...request, workingDirectory: resolvePath(request.workingDirectory) }
          : request;
        return await executeSandboxProcess(input.docker, container, processRequest, signal);
      });
    },
    async readFile(sessionId, path) {
      return await activity.runActive(sessionId, async () => {
        const container = await requireRunningContainer(input.docker, sessionId);
        const resolved = resolvePath(path);
        const stagingPath = `${FILE_UPLOAD_STAGING_DIRECTORY}/${randomUUID()}`;
        const copyResult = await executeSandboxProcess(input.docker, container, {
          command:
            `mkdir -p -- ${JSON.stringify(FILE_UPLOAD_STAGING_DIRECTORY)} && ` +
            `if [ ! -f ${JSON.stringify(resolved)} ]; then exit ${FILE_MISSING_EXIT_CODE}; fi && ` +
            `cp -T -- ${JSON.stringify(resolved)} ${JSON.stringify(stagingPath)}`,
        });
        if (copyResult.exitCode === FILE_MISSING_EXIT_CODE) return null;
        if (copyResult.exitCode !== 0) {
          throw new Error(
            "AGENT_SANDBOX_RUNNER_FILE_STAGE_FAILED: " +
            `Не удалось подготовить файл sandbox для чтения. ${copyResult.stderr}`,
          );
        }

        // Docker's archive API cannot read files from restricted HOME on tmpfs. Copying to rootfs
        // preserves binary archive reads while keeping the sandbox mount private and ephemeral.
        let readFailed = false;
        try {
          return await readSingleFileArchive(await container.getArchive({ path: stagingPath }));
        } catch (error) {
          readFailed = true;
          throw error;
        } finally {
          const cleanupResult = await executeSandboxProcess(input.docker, container, {
            command: `rm -f -- ${JSON.stringify(stagingPath)}`,
          });
          if (cleanupResult.exitCode !== 0) {
            console.error("Sandbox staged file cleanup failed", {
              exitCode: cleanupResult.exitCode,
              stagingPath,
              stderr: cleanupResult.stderr,
            });
            if (!readFailed) {
              throw new Error(
                "AGENT_SANDBOX_RUNNER_FILE_CLEANUP_FAILED: " +
                "Не удалось удалить временную копию прочитанного файла sandbox",
              );
            }
          }
        }
      });
    },
    async writeFile(sessionId, path, content) {
      await activity.runActive(sessionId, async () => {
        const container = await requireRunningContainer(input.docker, sessionId);
        const resolved = resolvePath(path);
        const stagingPath = `${FILE_UPLOAD_STAGING_DIRECTORY}/${randomUUID()}`;
        const directoryResult = await executeSandboxProcess(input.docker, container, {
          command:
            `mkdir -p -- ${JSON.stringify(posix.dirname(resolved))} ` +
            JSON.stringify(FILE_UPLOAD_STAGING_DIRECTORY),
        });
        if (directoryResult.exitCode !== 0) {
          throw new Error(
            "AGENT_SANDBOX_RUNNER_DIRECTORY_CREATE_FAILED: " +
            `Не удалось создать каталог для файла. ${directoryResult.stderr}`,
          );
        }

        // Docker's archive API cannot target tmpfs mounts such as restricted `$HOME`. Upload to
        // writable container rootfs first, then let an in-container process cross the mount boundary.
        let committed = false;
        try {
          await writeSingleFileArchive(container, stagingPath, content);
          const moveResult = await executeSandboxProcess(input.docker, container, {
            command: `mv -T -- ${JSON.stringify(stagingPath)} ${JSON.stringify(resolved)}`,
          });
          if (moveResult.exitCode !== 0) {
            throw new Error(
              "AGENT_SANDBOX_RUNNER_FILE_COMMIT_FAILED: " +
              `Не удалось записать файл в sandbox. ${moveResult.stderr}`,
            );
          }
          committed = true;
        } finally {
          if (!committed) {
            try {
              const cleanupResult = await executeSandboxProcess(input.docker, container, {
                command: `rm -f -- ${JSON.stringify(stagingPath)}`,
              });
              if (cleanupResult.exitCode !== 0) {
                console.error("Sandbox staged file cleanup failed", {
                  exitCode: cleanupResult.exitCode,
                  stagingPath,
                  stderr: cleanupResult.stderr,
                });
              }
            } catch (cleanupError) {
              console.error("Sandbox staged file cleanup failed", { cleanupError, stagingPath });
            }
          }
        }
      });
    },
    async removePath(sessionId, request: SandboxRunnerRemovePathRequest) {
      await activity.runActive(sessionId, async () => {
        const container = await requireRunningContainer(input.docker, sessionId);
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
      const existing = await inspectContainer(input.docker, sessionId);
      if (existing) {
        await existing.container.remove({ force: true, v: true }).catch((error) => {
          if (dockerStatus(error) !== 404) throw error;
        });
      }
      activity.forget(sessionId);
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
          label: [SANDBOX_SESSION_LABEL, `${SANDBOX_PROJECT_LABEL}=${input.runtime.project}`],
        },
      });
      await Promise.all(containers.map(async (item) => {
        await input.docker.getContainer(item.Id).remove({ force: true, v: true }).catch((error) => {
          if (dockerStatus(error) !== 404) throw error;
        });
      }));
      activity.clear();
    },
    async deleteToolEnvironment(workspaceId) {
      await rm(`${input.roots.toolsRoot}/${workspaceId}`, { force: true, recursive: true });
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
  const googleWorkspaceCredentialsVolume = mounts.find((mount) =>
    mount.Destination === MOUNT_GOOGLE_WORKSPACE_CREDENTIALS_DESTINATION
  )?.Name;
  if (!workspaceVolume || !toolsVolume || !googleWorkspaceCredentialsVolume) {
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
      googleWorkspaceCredentialsRoot: MOUNT_GOOGLE_WORKSPACE_CREDENTIALS_DESTINATION,
      toolsRoot: MOUNT_TOOLS_DESTINATION,
      workspaceRoot: MOUNT_WORKSPACES_DESTINATION,
    },
    runtime: {
      egressNetwork,
      googleWorkspaceCredentialsVolume,
      image,
      project: composeProject,
      toolsVolume,
      workspaceVolume,
    },
  };
}
