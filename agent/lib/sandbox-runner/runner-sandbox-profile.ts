/**
 * Sandbox runner access profiles.
 *
 * Exports:
 * - `BackendProfile`: immutable backend identity and access-classification contract.
 * - `ROOT_RUNNER_PROFILE`, `TASK_WORKER_RUNNER_PROFILE`: separate state/cache namespaces.
 * - `accessForMounts`: fail-closed root or worker access classification.
 * - `sandboxHome`: resolves persistent trusted HOME or ephemeral isolated HOME.
 */
import type {
  SandboxAccess,
  WorkspaceSandboxMount,
} from "./sandbox-runner-contract.js";

export interface BackendProfile {
  access: "automatic" | "worker";
  cacheDirectory: string;
  name: string;
  stateSchemaVersion: number;
}

export const ROOT_RUNNER_PROFILE: BackendProfile = {
  access: "automatic",
  cacheDirectory: "osinara-scoped-runner",
  name: "osinara-scoped-runner-v3",
  stateSchemaVersion: 3,
};

export const TASK_WORKER_RUNNER_PROFILE: BackendProfile = {
  access: "worker",
  cacheDirectory: "osinara-task-worker",
  name: "osinara-task-worker-v1",
  stateSchemaVersion: 1,
};

export function accessForMounts(
  mounts: readonly WorkspaceSandboxMount[],
  profile: BackendProfile,
): SandboxAccess {
  const hasGroup = mounts.some((mount) => mount.mountPoint === "group");
  const hasTrusted = mounts.some((mount) => mount.mountPoint !== "group");
  if (hasGroup === hasTrusted) {
    throw new Error("AGENT_SANDBOX_RUNNER_SCOPE_INVALID: Mixed or empty workspace mounts");
  }
  if (profile.access === "worker") {
    if (hasGroup) {
      throw new Error("AGENT_SANDBOX_RUNNER_SCOPE_INVALID: Worker cannot mount group workspaces");
    }
    return "worker";
  }
  return hasGroup ? "restricted" : "trusted";
}

export function sandboxHome(
  access: SandboxAccess,
  mounts: readonly WorkspaceSandboxMount[],
): string {
  if (access !== "trusted") return "/tmp/home";
  const primary = mounts.find((mount) => mount.mountPoint === "personal") ?? mounts[0];
  if (!primary || primary.mountPoint === "group") {
    throw new Error("AGENT_SANDBOX_RUNNER_SCOPE_INVALID: Trusted home scope is missing");
  }
  return `/tools/${primary.mountPoint}/home`;
}
