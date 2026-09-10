/**
 * How the runner obtains a running sandbox container and names one run of it.
 *
 * Exports:
 * - `inspectContainer`: the container of a session with its inspection, or null when absent.
 * - `requireRunningContainer`: a started, uncrowded container plus the identity of this run.
 * - `dockerStatus`: the HTTP status dockerode attaches to a failed Docker API call.
 *
 * Key construct:
 * - The pids cgroup counts threads, so a single Chromium (about 200 tasks) can exhaust the limit
 *   and every later operation fails inside the container. Crowded containers are restarted.
 * - One container run has an identity: a restart empties restricted `$HOME`, which is a tmpfs, so
 *   callers must be able to tell that everything they wrote into the previous run is gone.
 */
import Docker from "dockerode";

import { sandboxContainerName } from "./docker-sandbox-lifecycle.js";
import { SANDBOX_PIDS_REAP_THRESHOLD } from "./docker-sandbox-options.js";

/** Dockerode surfaces the HTTP status of a failed API call; 404 means the container is gone. */
export function dockerStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

export async function inspectContainer(
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

async function countContainerTasks(container: Docker.Container): Promise<number> {
  // `docker top` runs ps on the host, so it works even when the container itself cannot fork.
  // The pids cgroup counts threads, so the per-process thread count (nlwp) is what is summed.
  const top = (await container.top({ ps_args: "-eo pid,nlwp" })) as { Processes?: unknown[] };
  if (!Array.isArray(top.Processes)) return 0;
  return top.Processes.reduce<number>((total, row) => {
    const threads = Array.isArray(row) ? Number(row[1]) : Number.NaN;
    return total + (Number.isFinite(threads) && threads > 0 ? threads : 1);
  }, 0);
}

/** True when the container was restarted, so everything known about its previous run is stale. */
async function reapCrowdedContainer(container: Docker.Container, sessionId: string): Promise<boolean> {
  const tasks = await countContainerTasks(container);
  if (tasks < SANDBOX_PIDS_REAP_THRESHOLD) return false;
  // Workspace and tools are named volumes; the process tree is disposable compute.
  await container.restart({ t: 0 });
  console.error(JSON.stringify({
    code: "AGENT_SANDBOX_RUNNER_PROCESSES_REAPED",
    sessionId,
    tasks,
    threshold: SANDBOX_PIDS_REAP_THRESHOLD,
  }));
  return true;
}

/**
 * The identity of one container run. Restricted `$HOME` is a tmpfs, so a restart empties it: the
 * start time belongs to the identity, and anything remembered about the previous run is void.
 */
function containerGeneration(inspection: Docker.ContainerInspectInfo): string | null {
  const startedAt: unknown = inspection.State.StartedAt;
  if (!inspection.Id || typeof startedAt !== "string" || startedAt.length === 0) return null;
  return `${inspection.Id} ${startedAt}`;
}

export async function requireRunningContainer(
  docker: Docker,
  sessionId: string,
  activeOperations: number,
): Promise<{ container: Docker.Container; generation: string | null }> {
  const existing = await inspectContainer(docker, sessionId);
  if (!existing) throw new Error("AGENT_SANDBOX_RUNNER_SESSION_NOT_FOUND: Sandbox is absent");
  let inspection = existing.inspection;
  if (!inspection.State.Running) {
    await existing.container.start();
    inspection = await existing.container.inspect();
  } else if (activeOperations <= 1) {
    // A restart kills every process of the session: only the caller may be running in it.
    if (await reapCrowdedContainer(existing.container, sessionId)) {
      inspection = await existing.container.inspect();
    }
  }
  return { container: existing.container, generation: containerGeneration(inspection) };
}
