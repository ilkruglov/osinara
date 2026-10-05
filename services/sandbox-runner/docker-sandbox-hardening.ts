/**
 * Network and process limits a sandbox container cannot lift itself.
 *
 * Exports:
 * - `applyEgressFirewall`: in the container's network namespace, outgoing traffic only to the
 *   egress proxy port (and loopback, Docker's DNS), incoming only replies; set by a short-lived
 *   helper with NET_ADMIN, which the sandbox itself never has.
 * - `killStrayProcesses`: after a command, every process left in the container except its own
 *   placeholder and the reader's daemons.
 *
 * Key constructs:
 * - Every trusted sandbox of every family sits on the one `sandbox-egress` bridge, so a model's
 *   Bash could reach another family's sandbox (or its browser companion) directly; only egress to
 *   the internet was policed, by the proxy (security review, 5 October 2026). The rules live in
 *   the namespace, so they need no host change and hold whatever the host's bridge settings are;
 *   a restart creates a new namespace, so they are applied after every start.
 * - A command could leave processes running after it (`nohup`, `setsid`, `&`): a miner or a
 *   reverse shell lived until the container's idle stop, hours later. Eve's background commands
 *   are ordinary runner calls too, so nothing legitimate outlives a command except the container's
 *   `sleep` and the Lightpanda reader's daemons; they are told apart by the executable, which the
 *   model cannot replace now that the root filesystem is read-only.
 */
import type Docker from "dockerode";

const FIREWALL_TIMEOUT_MS = 30_000;
export const EGRESS_PROXY_PORT = 3128;

// Idempotent: the chains are created once and flushed on every application.
const FIREWALL_SCRIPT = [
  "set -e",
  "for t in iptables ip6tables; do",
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
  `iptables -A OSINARA-OUT -p tcp --dport ${EGRESS_PROXY_PORT} -m conntrack --ctstate NEW -j ACCEPT`,
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
  const helper = await docker.createContainer({
    Cmd: ["sh", "-c", FIREWALL_SCRIPT],
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

// Executables that may outlive a command: the container's placeholder (`sleep infinity`) and
// the Lightpanda reader's daemons. Paths under the read-only root, so not the model's to replace.
const KEPT_EXECUTABLES = [
  "/usr/bin/sleep",
  "/usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64",
  "/usr/local/bin/lightpanda",
];

const KILL_SCRIPT = `
import os, signal
keep = set(${JSON.stringify(KEPT_EXECUTABLES)})
# This script and the timeout that bounds it are not strays.
me = {os.getpid(), os.getppid()}
killed = 0
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    if pid == 1 or pid in me:
        continue
    try:
        exe = os.readlink("/proc/%d/exe" % pid)
    except OSError:
        continue
    if exe in keep:
        continue
    try:
        os.kill(pid, signal.SIGKILL)
        killed += 1
    except OSError:
        pass
print(killed)
`;

/** Kills what a finished command left behind; the count of killed processes. */
export async function killStrayProcesses(container: Docker.Container): Promise<number> {
  const exec = await container.exec({
    AttachStderr: false,
    AttachStdout: true,
    Cmd: ["timeout", "--signal=KILL", "20", "python3", "-c", KILL_SCRIPT],
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
  // Docker frames stdout with an 8-byte header; the count is the digits in it.
  const digits = Buffer.concat(chunks).toString("latin1").match(/\d+/gu);
  return digits ? Number(digits.at(-1)) : 0;
}
