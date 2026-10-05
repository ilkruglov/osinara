/**
 * Pure Docker container configuration for Osinara sandboxes.
 *
 * Exports:
 * - `SandboxDockerRuntime`: resolved Docker resources owned by Compose.
 * - `SANDBOX_CONTAINER_POLICY_VERSION`: invalidates containers created under older runtime policy.
 * - `buildSandboxContainerOptions`: creates fail-closed scoped container options.
 * - `buildGoogleWorkspaceContainerOptions`: creates a one-shot credential boundary.
 * - `resolveTrustedToolMount`: selects the only persistent HOME mount for a trusted session.
 * - `buildBrowserContainerOptions`: the companion container of a trusted session that runs the
 *   authenticated browser, apart from the model's Bash.
 * - `BROWSER_CONTAINER_ROLE`, `SANDBOX_ROLE_LABEL`, `browserStateSubpath`: how that container is
 *   told apart and where its state lives.
 *
 * Key construct:
 * - The browser with the family's cookies used to run in the same container as the model's Bash.
 *   Chromium listens for DevTools on 127.0.0.1 (`--remote-debugging-port=0`) and the agent-browser
 *   daemon on a socket in HOME, so any process there could drive the logged-in browser past the
 *   confirmation gate; the Bash command filter only matched spellings (security review and Codex
 *   security scan, 5 October 2026). The browser now lives in its own container: its own network
 *   namespace and filesystem, state in a tools-volume directory the Bash container never mounts,
 *   and no workspace at all: screenshots travel through the application (Codex review: a link
 *   planted in a shared shots folder led the companion's writes into its own state).
 */
import type Docker from "dockerode";

import type {
  GoogleWorkspaceExecutionRequest,
  SandboxRunnerCreateRequest,
  SandboxRunnerMount,
} from "../../agent/lib/sandbox-runner/sandbox-runner-contract.js";

export interface SandboxDockerRuntime {
  browserlessApiKey?: string;
  egressNetwork: string;
  image: string;
  project: string;
  toolsVolume: string;
  workspaceVolume: string;
}

export const SANDBOX_CONTAINER_POLICY_VERSION = "18";
export const SANDBOX_ROLE_LABEL = "dev.osinara.sandbox.role";
export const BROWSER_CONTAINER_ROLE = "browser";
/** The browser state of one tool workspace, beside (never inside) the directory Bash mounts. */
export function browserStateSubpath(workspaceId: string): string {
  return `browser/${workspaceId}`;
}

const AGENT_BROWSER_SESSION_NAME = "osinara";
const AGENT_BROWSER_RESTORE_SAVE_POLICY = "auto";
// Headless Chrome announces automation: `navigator.webdriver` is true and the UA says
// HeadlessChrome. lavka.yandex.ru answered such a browser with 403 «доступ временно заблокирован»
// (26 September 2026) while curl on the same egress got 200; with the marker off and a plain
// Chrome UA the same browser got the page. Chrome for Testing 152 reports Chrome/152.0.0.0.
const AGENT_BROWSER_CHROME_ARGS = "--disable-blink-features=AutomationControlled";
const AGENT_BROWSER_USER_AGENT_VALUE =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
// One Chromium holds about 500 MiB; the default daemon idle of one hour kept it after every turn.
const AGENT_BROWSER_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const PROXY_URL = "http://sandbox-egress-proxy:3128";
const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const GOOGLE_WORKSPACE_BINARY = "/opt/osinara/gws";
const RUSSIAN_TRUSTED_ROOT_CA_PATH =
  "/usr/local/share/ca-certificates/russian-trusted-root-ca.crt";
const SANDBOX_CPU_NANOSECONDS = 1_000_000_000;
const SANDBOX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
// The pids cgroup counts threads, not processes: one agent-browser Chromium is about 200 tasks,
// so the former limit of 256 wedged page loads inside a single session and a second daemon hit
// EAGAIN outright. The budget now holds a few sessions; anything beyond is leftover daemons.
const SANDBOX_PIDS_LIMIT = 1024;
// Between commands only daemons stay alive (agent-browser and its Chromium tree). Once their
// threads take half the budget the next `mkdir` in the container is at risk of EAGAIN and every
// turn would die in its preamble, so the runner restarts the disposable compute first.
export const SANDBOX_PIDS_REAP_THRESHOLD = SANDBOX_PIDS_LIMIT / 2;
const SANDBOX_SHM_BYTES = 256 * 1024 * 1024;

function volumeMount(source: string, target: string, subpath: string): Docker.MountSettings {
  // Docker Engine accepts Subpath without the optional driver fields over the HTTP API.
  return {
    Source: source,
    Target: target,
    Type: "volume",
    VolumeOptions: { Subpath: subpath },
  } as Docker.MountSettings;
}

function workspaceMounts(
  runtime: SandboxDockerRuntime,
  mounts: readonly SandboxRunnerMount[],
): Docker.MountSettings[] {
  return mounts.map((mount) =>
    volumeMount(runtime.workspaceVolume, `/workspace/${mount.mountPoint}`, mount.workspaceId)
  );
}

export function resolveTrustedToolMount(
  mounts: readonly SandboxRunnerMount[],
): SandboxRunnerMount {
  // Private sessions prefer personal state; family sessions have only their family mount.
  const primary = mounts.find((mount) => mount.mountPoint === "personal") ?? mounts[0];
  if (!primary || primary.mountPoint === "group") {
    throw new Error(
      "AGENT_SANDBOX_RUNNER_TOOL_SCOPE_INVALID: Trusted tool environment is missing",
    );
  }
  return primary;
}

function toolsMount(
  runtime: SandboxDockerRuntime,
  mounts: readonly SandboxRunnerMount[],
): Docker.MountSettings {
  const mount = resolveTrustedToolMount(mounts);
  return volumeMount(runtime.toolsVolume, `/tools/${mount.mountPoint}`, mount.workspaceId);
}

function trustedEnvironment(mounts: readonly SandboxRunnerMount[], browserlessApiKey?: string): string[] {
  const primary = resolveTrustedToolMount(mounts);
  const root = `/tools/${primary.mountPoint}`;
  const executablePaths = [`${root}/npm/bin`, `${root}/python/bin`, `${root}/bin`];
  return [
    // Only whether the cloud browser exists: the key stays in the egress proxy, which adds it on
    // its Browserless endpoint (security review, 5 October 2026).
    ...(browserlessApiKey ? ["BROWSERLESS_AVAILABLE=true"] : []),
    // Bash keeps only the reader (Lightpanda, no logins). Chrome's arguments belong to the
    // browser container: Lightpanda refuses to start with them ("Custom Chrome arguments are not
    // supported", seen live 5 October 2026), so with them in this environment the reader the
    // skill prescribes could not run at all.
    `AGENT_BROWSER_USER_AGENT=${AGENT_BROWSER_USER_AGENT_VALUE}`,
    `AGENT_BROWSER_IDLE_TIMEOUT_MS=${AGENT_BROWSER_IDLE_TIMEOUT_MS}`,
    `AGENT_BROWSER_PROXY=${PROXY_URL}`,
    // Lightpanda reports usage to its vendor by default; a family sandbox reports nothing.
    "LIGHTPANDA_DISABLE_TELEMETRY=true",
    `HOME=${root}/home`,
    `PATH=${[...executablePaths, BASE_PATH].join(":")}`,
    `NPM_CONFIG_PREFIX=${root}/npm`,
    `NODE_EXTRA_CA_CERTS=${RUSSIAN_TRUSTED_ROOT_CA_PATH}`,
    "NODE_USE_ENV_PROXY=1",
    `PIP_CACHE_DIR=${root}/cache/pip`,
    `PLAYWRIGHT_BROWSERS_PATH=${root}/cache/ms-playwright`,
    `XDG_CACHE_HOME=${root}/cache`,
    `VIRTUAL_ENV=${root}/python`,
    `HTTP_PROXY=${PROXY_URL}`,
    `HTTPS_PROXY=${PROXY_URL}`,
    `http_proxy=${PROXY_URL}`,
    `https_proxy=${PROXY_URL}`,
    "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
    "LANG=C.UTF-8",
  ];
}

function browserEnvironment(): string[] {
  return [
    `AGENT_BROWSER_ARGS=${AGENT_BROWSER_CHROME_ARGS}`,
    `AGENT_BROWSER_USER_AGENT=${AGENT_BROWSER_USER_AGENT_VALUE}`,
    `AGENT_BROWSER_IDLE_TIMEOUT_MS=${AGENT_BROWSER_IDLE_TIMEOUT_MS}`,
    `AGENT_BROWSER_PROXY=${PROXY_URL}`,
    `AGENT_BROWSER_RESTORE=${AGENT_BROWSER_SESSION_NAME}`,
    `AGENT_BROWSER_RESTORE_SAVE=${AGENT_BROWSER_RESTORE_SAVE_POLICY}`,
    `AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION_NAME}`,
    "LIGHTPANDA_DISABLE_TELEMETRY=true",
    `HOME=${BROWSER_STATE_TARGET}/home`,
    `PATH=${BASE_PATH}`,
    `NODE_EXTRA_CA_CERTS=${RUSSIAN_TRUSTED_ROOT_CA_PATH}`,
    "NODE_USE_ENV_PROXY=1",
    `XDG_CACHE_HOME=${BROWSER_STATE_TARGET}/cache`,
    `HTTP_PROXY=${PROXY_URL}`,
    `HTTPS_PROXY=${PROXY_URL}`,
    `http_proxy=${PROXY_URL}`,
    `https_proxy=${PROXY_URL}`,
    "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
    "LANG=C.UTF-8",
  ];
}

const BROWSER_STATE_TARGET = "/browser";

export const SANDBOX_PARENT_LABEL = "dev.osinara.sandbox.parent-id";

/**
 * The browser companion of a trusted session: only its browser state (no workspace, no tool
 * environment), no Browserless key. Limits, capabilities and network are those of the session's
 * own container; the parent label ties it to that container's run.
 */
export function buildBrowserContainerOptions(
  runtime: SandboxDockerRuntime,
  input: {
    eveSessionId: string;
    parentContainerId: string;
    sandboxSessionId: string;
    toolsWorkspaceId: string;
  },
): Docker.ContainerCreateOptions {
  const mounts = [volumeMount(runtime.toolsVolume, BROWSER_STATE_TARGET, browserStateSubpath(input.toolsWorkspaceId))];
  return {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: ["sleep", "infinity"],
    Env: browserEnvironment(),
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: mounts,
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: runtime.egressNetwork,
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      // Writable only through volumes and tmpfs: a write into the root would land in the
      // container layer on the host disk, past every workspace limit (security review).
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      ShmSize: SANDBOX_SHM_BYTES,
      Tmpfs: {
        "/opt/osinara": "ro,noexec,nosuid,size=64k,mode=0555",
        "/tmp": "rw,noexec,nosuid,size=512m,mode=1777",
        "/var/tmp": "rw,noexec,nosuid,size=64m,mode=1777",
      },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.sandbox.access": "trusted",
      "dev.osinara.sandbox.eve-session-id": input.eveSessionId,
      "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION,
      "dev.osinara.sandbox.project": runtime.project,
      [SANDBOX_PARENT_LABEL]: input.parentContainerId,
      [SANDBOX_ROLE_LABEL]: BROWSER_CONTAINER_ROLE,
      // The session label makes the capacity cap, idle stop and cleanup count this container
      // with its session; lookups of the session's own container go by name.
      "dev.osinara.sandbox.session-id": input.sandboxSessionId,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: BROWSER_STATE_TARGET,
  };
}

function isolatedEnvironment(): string[] {
  return [
    "HOME=/tmp/home",
    `PATH=${BASE_PATH}`,
    "LANG=C.UTF-8",
  ];
}

export function buildSandboxContainerOptions(
  runtime: SandboxDockerRuntime,
  request: SandboxRunnerCreateRequest,
): Docker.ContainerCreateOptions {
  const trusted = request.access === "trusted";
  const mounts = workspaceMounts(runtime, request.mounts);
  if (trusted) {
    mounts.push(toolsMount(runtime, request.mounts));
  }

  return {
    AttachStderr: false,
    AttachStdin: false,
    AttachStdout: false,
    Cmd: ["sleep", "infinity"],
    Env: trusted ? trustedEnvironment(request.mounts, runtime.browserlessApiKey) : isolatedEnvironment(),
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      // Docker's init process reaps Chromium descendants so durable sandboxes do not exhaust PIDs.
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: mounts,
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: trusted ? runtime.egressNetwork : "none",
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      // Writable only through volumes and tmpfs: a write into the root would land in the
      // container layer on the host disk, past every workspace limit (security review).
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      ShmSize: SANDBOX_SHM_BYTES,
      // The shared image contains gws, but durable model-controlled Bash must never see it.
      Tmpfs: {
        "/opt/osinara": "ro,noexec,nosuid,size=64k,mode=0555",
        "/tmp": "rw,noexec,nosuid,size=512m,mode=1777",
        "/var/tmp": "rw,noexec,nosuid,size=64m,mode=1777",
      },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.sandbox.access": request.access,
      "dev.osinara.sandbox.eve-session-id": request.eveSessionId,
      "dev.osinara.sandbox.policy-version": SANDBOX_CONTAINER_POLICY_VERSION,
      "dev.osinara.sandbox.project": runtime.project,
      "dev.osinara.sandbox.session-id": request.sandboxSessionId,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    // The main writable workspace: /workspace itself lies on the read-only root, so commands
    // that create files in the current directory (git clone, a report) would fail there.
    WorkingDir: `/workspace/${trusted ? resolveTrustedToolMount(request.mounts).mountPoint : request.mounts[0]?.mountPoint ?? "group"}`,
  };
}

export function buildGoogleWorkspaceContainerOptions(
  runtime: SandboxDockerRuntime,
  request: GoogleWorkspaceExecutionRequest,
): Docker.ContainerCreateOptions {
  return {
    AttachStderr: true,
    AttachStdin: false,
    AttachStdout: true,
    Cmd: [GOOGLE_WORKSPACE_BINARY, ...request.argv],
    Env: [
      `GOOGLE_WORKSPACE_CLI_TOKEN=${request.accessToken}`,
      "HOME=/tmp",
      `HTTP_PROXY=${PROXY_URL}`,
      `HTTPS_PROXY=${PROXY_URL}`,
      "LANG=C.UTF-8",
      "NO_PROXY=localhost,127.0.0.1,sandbox-egress-proxy",
      `http_proxy=${PROXY_URL}`,
      `https_proxy=${PROXY_URL}`,
    ],
    HostConfig: {
      AutoRemove: false,
      CapDrop: ["ALL"],
      Init: true,
      Memory: SANDBOX_MEMORY_BYTES,
      Mounts: [volumeMount(runtime.workspaceVolume, "/workspace", request.workspaceId)],
      NanoCpus: SANDBOX_CPU_NANOSECONDS,
      NetworkMode: runtime.egressNetwork,
      PidsLimit: SANDBOX_PIDS_LIMIT,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m,mode=1777" },
    },
    Image: runtime.image,
    Labels: {
      "dev.osinara.google-workspace-execution": "true",
      "dev.osinara.sandbox.project": runtime.project,
    },
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    WorkingDir: "/workspace",
  };
}
