/**
 * Network and process limits a sandbox container cannot lift itself.
 *
 * Exports:
 * - `applyEgressFirewall`: in the container's network namespace, outgoing traffic only to the
 *   egress proxy port (and loopback, Docker's DNS), incoming only replies; set by a short-lived
 *   helper with NET_ADMIN, which the sandbox itself never has.
 * - `createStartBarrier`: applies such rules once per container run and makes every operation on
 *   the run wait for them; a failure stops the container.
 * - `killStrayProcesses`: after a command, every process left in the container except its own
 *   placeholder and the reader's daemons.
 * - `STRAY_SWEEP_PYTHON`: the sweep's Python definitions, run against a fake /proc in tests.
 *
 * Key constructs:
 * - Every trusted sandbox of every family sits on the one `sandbox-egress` bridge, so a model's
 *   Bash could reach another family's sandbox (or its browser companion) directly; only egress to
 *   the internet was policed, by the proxy (security review, 5 October 2026). The rules live in
 *   the namespace, so they need no host change and hold whatever the host's bridge settings are;
 *   a restart creates a new namespace, so they are applied after every start.
 * - The proxy port is open only inside the egress network's subnet, and the network's gateway is
 *   closed: an internal Docker network still reaches the host's own listeners through it (checked
 *   on local Docker, 7 November 2026), so a host service on the proxy port was reachable (Codex
 *   review, 6 November 2026). The proxy's own address is not pinned: a deploy recreates the proxy
 *   and may give it another. Other sandboxes in the subnet refuse new connections themselves.
 * - A command could leave processes running after it (`nohup`, `setsid`, `&`): a miner or a
 *   reverse shell lived until the container's idle stop, hours later. Eve's background commands
 *   are ordinary runner calls too, so nothing legitimate outlives a command except the container's
 *   `sleep` and the Lightpanda reader's daemons; they are told apart by the executable, which the
 *   model cannot replace now that the root filesystem is read-only.
 */
import type Docker from "dockerode";

import { containerGeneration } from "./docker-sandbox-container.js";
import { SANDBOX_SYSTEM_PATH } from "./docker-sandbox-process.js";

const FIREWALL_TIMEOUT_MS = 30_000;
export const EGRESS_PROXY_PORT = 3128;

interface EgressSubnet {
  gateway: string | null;
  subnet: string;
}

const IPV4 = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}`;
const IPV4_PATTERN = new RegExp(`^${IPV4}$`, "u");
const IPV4_SUBNET_PATTERN = new RegExp(String.raw`^${IPV4}/(?:3[0-2]|[12]?\d)$`, "u");

function firewallFailed(reason: string): Error {
  return new Error(`AGENT_SANDBOX_RUNNER_FIREWALL_FAILED: ${reason}`);
}

/** The IPv4 subnet and gateway of the sandbox's egress network, checked before they reach a shell. */
async function egressSubnet(docker: Docker, networkId: string): Promise<EgressSubnet> {
  const network = await docker.getNetwork(networkId).inspect() as { IPAM?: { Config?: Array<{ Gateway?: string; Subnet?: string }> } };
  const config = (network.IPAM?.Config ?? []).find((entry) => typeof entry.Subnet === "string" && entry.Subnet.includes("."));
  if (!config?.Subnet || !IPV4_SUBNET_PATTERN.test(config.Subnet)) throw firewallFailed("The egress network has no IPv4 subnet");
  const gateway = config.Gateway ?? "";
  if (gateway !== "" && !IPV4_PATTERN.test(gateway)) throw firewallFailed("The egress network's gateway is not an IPv4 address");
  return { gateway: gateway === "" ? null : gateway, subnet: config.Subnet };
}

// Idempotent: the chains are created once and flushed on every application. The policies go to
// DROP first, so a re-application on a running container is closed while the chains are empty.
const firewallScript = (network: EgressSubnet) => [
  "set -e",
  "for t in iptables ip6tables; do",
  "  $t -P OUTPUT DROP",
  "  $t -P INPUT DROP",
  "  $t -N OSINARA-OUT 2>/dev/null || $t -F OSINARA-OUT",
  "  $t -N OSINARA-IN 2>/dev/null || $t -F OSINARA-IN",
  "  $t -C OUTPUT -j OSINARA-OUT 2>/dev/null || $t -I OUTPUT -j OSINARA-OUT",
  "  $t -C INPUT -j OSINARA-IN 2>/dev/null || $t -I INPUT -j OSINARA-IN",
  "  $t -A OSINARA-OUT -o lo -j ACCEPT",
  "  $t -A OSINARA-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
  "  $t -A OSINARA-IN -i lo -j ACCEPT",
  "  $t -A OSINARA-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
  "  $t -A OSINARA-IN -j DROP",
  "done",
  ...(network.gateway === null ? [] : [`iptables -A OSINARA-OUT -d ${network.gateway} -j REJECT`]),
  `iptables -A OSINARA-OUT -p tcp -d ${network.subnet} --dport ${EGRESS_PROXY_PORT} -m conntrack --ctstate NEW -j ACCEPT`,
  "iptables -A OSINARA-OUT -j REJECT",
  "ip6tables -A OSINARA-OUT -j REJECT",
].join("\n");

export async function applyEgressFirewall(
  docker: Docker,
  image: string,
  container: Docker.Container,
  project: string,
): Promise<void> {
  const inspection = await container.inspect();
  // A restricted sandbox has no network at all.
  if (inspection.HostConfig.NetworkMode === "none") return;
  const networkId = Object.values(inspection.NetworkSettings?.Networks ?? {})[0]?.NetworkID;
  if (!networkId) throw firewallFailed("The sandbox is on no network");
  const network = await egressSubnet(docker, networkId);
  const helper = await docker.createContainer({
    Cmd: ["sh", "-c", firewallScript(network)],
    HostConfig: {
      AutoRemove: false,
      CapAdd: ["NET_ADMIN", "NET_RAW"],
      CapDrop: ["ALL"],
      NetworkMode: `container:${inspection.Id}`,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
    },
    Image: image,
    Labels: { "dev.osinara.sandbox.firewall": "true", "dev.osinara.sandbox.project": project },
  });
  try {
    await helper.start();
    const result = await Promise.race([
      helper.wait() as Promise<{ StatusCode: number }>,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("AGENT_SANDBOX_RUNNER_FIREWALL_TIMED_OUT: Network rules were not applied in time")),
        FIREWALL_TIMEOUT_MS,
      )),
    ]);
    if (result.StatusCode !== 0) {
      const logs = (await helper.logs({ stderr: true, stdout: true })).toString("utf8").slice(-400);
      throw new Error(`AGENT_SANDBOX_RUNNER_FIREWALL_FAILED: ${logs}`);
    }
  } finally {
    await helper.remove({ force: true }).catch(() => undefined);
  }
  const address = Object.values(inspection.NetworkSettings?.Networks ?? {})[0]?.IPAddress ?? "";
  console.info(JSON.stringify({
    address,
    code: "AGENT_SANDBOX_RUNNER_FIREWALL_APPLIED",
    container: inspection.Name?.replace(/^\//u, ""),
  }));
}

const MAX_TRACKED_RUNS = 2_000;

/**
 * The container is `Running` the moment it starts, before its rules are laid: an operation of
 * the session arriving then, or after a failed attempt on a resumed container, ran without them
 * (Codex review, 5 October 2026). Every operation passes here with the run it found; one run is
 * one application, shared by everyone who arrives while it is laid, and a failed one stops the
 * container, so the next call starts it again and tries again.
 */
export function createStartBarrier(apply: (container: Docker.Container) => Promise<void>) {
  // Least recently used first. A failed run keeps its rejection: the run is over once stopped,
  // and only a new start (a new generation) applies again; an operation arriving while the stop
  // is under way must not lay a second set and slip in (Codex review, 5 October 2026). Past the
  // cap the least recently used settled run is forgotten, never one still being laid; seen
  // again, its rules are laid again, which the script does closed (DROP policies).
  const runs = new Map<string, { generation: string; ready: Promise<void>; settled: boolean }>();
  return async (container: Docker.Container, inspection?: Docker.ContainerInspectInfo): Promise<void> => {
    const info = inspection ?? await container.inspect();
    const generation = containerGeneration(info);
    const known = runs.get(info.Id);
    if (generation !== null && known?.generation === generation) {
      runs.delete(info.Id);
      runs.set(info.Id, known);
      return await known.ready;
    }
    const run = { generation: generation ?? "", ready: Promise.resolve(), settled: false };
    run.ready = apply(container).catch(async (error: unknown) => {
      await container.stop({ t: 0 }).catch(() => undefined);
      throw error;
    }).finally(() => {
      run.settled = true;
    });
    if (generation !== null) {
      runs.delete(info.Id);
      runs.set(info.Id, run);
      for (const [id, tracked] of runs) {
        if (runs.size <= MAX_TRACKED_RUNS) break;
        if (tracked.settled) runs.delete(id);
      }
    }
    return await run.ready;
  };
}

// Executables that may outlive a command: the container's placeholder (`sleep infinity`) and
// the Lightpanda reader's daemons. Paths under the read-only root, so not the model's to replace.
const KEPT_EXECUTABLES = [
  "/usr/bin/sleep",
  "/usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64",
  "/usr/local/bin/lightpanda",
];

/**
 * The sweep in Python, as definitions: `sweep(proc, kill, me)` kills every process under `proc`
 * except pid 1, `me` and the kept executables, and returns the count. A process can make its
 * executable unreadable (`prctl(PR_SET_DUMPABLE, 0)`), and the sweep used to pass over what it could
 * not read, so such a process outlived the command (Codex review, 6 November 2026). None of the
 * kept executables does that, so unreadable means a stray; only a process already gone (its entry
 * or its executable vanished: an exit, a zombie) is passed over.
 */
export const STRAY_SWEEP_PYTHON = `
import os, signal
KEEP = set(${JSON.stringify(KEPT_EXECUTABLES)})
def sweep(proc, kill, me):
    killed = 0
    for name in os.listdir(proc):
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == 1 or pid in me:
            continue
        try:
            exe = os.readlink(os.path.join(proc, name, "exe"))
        except FileNotFoundError:
            continue
        except OSError:
            exe = None
        if exe in KEEP:
            continue
        try:
            kill(pid, signal.SIGKILL)
            killed += 1
        except OSError:
            pass
    return killed
`;

// This script and the timeout that bounds it are not strays.
const KILL_SCRIPT = `${STRAY_SWEEP_PYTHON}
print(sweep("/proc", os.kill, {os.getpid(), os.getppid()}))
`;

/**
 * Kills what a finished command left behind; the count of killed processes. The container's
 * PATH starts with directories the model writes, so the tools are named by absolute path under
 * the read-only root, with the system PATH and Python isolated from the environment and user
 * site; a planted `timeout` or `python3` used to run instead (Codex review, 5 October 2026).
 */
export async function killStrayProcesses(container: Docker.Container): Promise<number> {
  const exec = await container.exec({
    AttachStderr: false,
    AttachStdout: true,
    Cmd: ["/usr/bin/timeout", "--signal=KILL", "20", "/usr/bin/python3", "-I", "-c", KILL_SCRIPT],
    Env: [`PATH=${SANDBOX_SYSTEM_PATH}`],
    Tty: false,
    WorkingDir: "/",
  });
  const stream = await exec.start({ Tty: false });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
    stream.once("error", () => resolve());
  });
  const { ExitCode } = await exec.inspect();
  if (ExitCode !== 0) {
    throw new Error(`AGENT_SANDBOX_RUNNER_CLEANUP_FAILED: The stray process sweep exited with ${ExitCode}`);
  }
  // Docker frames stdout with an 8-byte header; the count is the digits in it.
  const digits = Buffer.concat(chunks).toString("latin1").match(/\d+/gu);
  return digits ? Number(digits.at(-1)) : 0;
}
