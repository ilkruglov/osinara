/**
 * Network rules and stray processes of a sandbox.
 *
 * Constructs covered:
 * - The firewall runs in a short-lived helper in the sandbox's network namespace with NET_ADMIN
 *   (the sandbox never has it), allows only the proxy port, loopback and replies, and is
 *   skipped for a sandbox without network; a failed helper fails the start with a code.
 * - The proxy port is open only inside the egress network's subnet and never to its gateway,
 *   which is the host: a host service on that port was reachable (Codex review, 6 November 2026;
 *   checked on local Docker: an internal network still reaches the host's own listeners). A
 *   network whose subnet cannot be read fails the start.
 * - The stray-process cleanup kills everything but the placeholder and the reader's daemons,
 *   never itself or its timeout, and reports the count; it runs the system's own tools by
 *   absolute path with the system PATH and isolated Python, and a failed sweep throws. A process
 *   whose executable cannot be read (it made itself non-dumpable) is killed too; only one already
 *   gone is passed over (Codex review, 6 November 2026: such a process outlived the sweep).
 * - `createStartBarrier`: one application per container run, awaited by everyone who arrives
 *   while it is laid; a failure stops the container and the next run applies again.
 * - Checked live on Docker (5 October 2026): proxy:3128 reachable, a neighbour sandbox and other
 *   ports not, DNS working, a `nohup` process gone after the command.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { applyEgressFirewall, createStartBarrier, killStrayProcesses, STRAY_SWEEP_PYTHON } from "./docker-sandbox-hardening.js";

// The sweep is Python run inside the sandbox image; the test image of CI has no Python, so the run
// against a fake /proc happens where Python is (checked live on the sandbox image, 7 November 2026).
const PYTHON_AVAILABLE = spawnSync("python3", ["--version"]).status === 0;

function containerWith(networkMode: string) {
  return {
    inspect: vi.fn(async () => ({ HostConfig: { NetworkMode: networkMode }, Id: "sandbox-id", Name: "/osinara-sandbox-x", NetworkSettings: { Networks: { egress: { IPAddress: "172.20.0.5", NetworkID: "egress-network-id" } } } })),
  } as unknown as Docker.Container;
}

function dockerWith(helper: unknown, ipam: unknown = [{ Gateway: "172.20.0.1", Subnet: "172.20.0.0/16" }]) {
  return {
    createContainer: vi.fn(async () => helper),
    getNetwork: vi.fn(() => ({ inspect: vi.fn(async () => ({ IPAM: { Config: ipam } })) })),
  } as unknown as Docker;
}

describe("applyEgressFirewall", () => {
  it("lays the rules from a NET_ADMIN helper in the sandbox's namespace", async () => {
    const helper = { logs: vi.fn(), remove: vi.fn(async () => undefined), start: vi.fn(async () => undefined), wait: vi.fn(async () => ({ StatusCode: 0 })) };
    const docker = dockerWith(helper);

    await applyEgressFirewall(docker, "sandbox-image", containerWith("osinara_sandbox-egress"), "osinara");

    const options = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(options.HostConfig).toMatchObject({ CapAdd: ["NET_ADMIN", "NET_RAW"], CapDrop: ["ALL"], NetworkMode: "container:sandbox-id" });
    const script = options.Cmd.at(-1) as string;
    expect(docker.getNetwork).toHaveBeenCalledWith("egress-network-id");
    expect(script).toContain("iptables -A OSINARA-OUT -p tcp -d 172.20.0.0/16 --dport 3128 -m conntrack --ctstate NEW -j ACCEPT");
    expect(script.indexOf("-d 172.20.0.1 -j REJECT")).toBeGreaterThan(-1);
    expect(script.indexOf("-d 172.20.0.1 -j REJECT")).toBeLessThan(script.indexOf("--dport 3128"));
    const proxyPortRules = script.split("\n").filter((line) => line.includes("--dport 3128"));
    expect(proxyPortRules).toHaveLength(1);
    expect(proxyPortRules.every((line) => line.includes("-d 172.20.0.0/16"))).toBe(true);
    expect(script).toContain("OSINARA-IN -j DROP");
    expect(script).toContain("OSINARA-OUT -j REJECT");
    expect(helper.remove).toHaveBeenCalled();
  });

  it.each([
    ["no IPv4 subnet", [{ Subnet: "fd00::/64" }]],
    ["a malformed subnet", [{ Gateway: "172.20.0.1", Subnet: "172.20.0.0/16; reboot" }]],
    ["no configuration", []],
  ])("fails the start when the egress network has %s", async (_name, ipam) => {
    const docker = dockerWith({}, ipam);
    await expect(applyEgressFirewall(docker, "image", containerWith("egress"), "osinara")).rejects.toThrow("AGENT_SANDBOX_RUNNER_FIREWALL_FAILED");
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("skips a sandbox without network and fails a start whose rules did not apply", async () => {
    const docker = { createContainer: vi.fn() } as unknown as Docker;
    await applyEgressFirewall(docker, "image", containerWith("none"), "osinara");
    expect(docker.createContainer).not.toHaveBeenCalled();

    const helper = { logs: vi.fn(async () => Buffer.from("iptables: not found")), remove: vi.fn(async () => undefined), start: vi.fn(async () => undefined), wait: vi.fn(async () => ({ StatusCode: 1 })) };
    const failing = dockerWith(helper);
    await expect(applyEgressFirewall(failing, "image", containerWith("egress"), "osinara")).rejects.toThrow("AGENT_SANDBOX_RUNNER_FIREWALL_FAILED");
    expect(helper.remove).toHaveBeenCalled();
  });
});

describe("killStrayProcesses", () => {
  it("runs the cleanup in the container, sparing itself and its timeout, and returns the count", async () => {
    const exec = vi.fn(async () => ({
      inspect: vi.fn(async () => ({ ExitCode: 0 })),
      start: vi.fn(async () => Readable.from([Buffer.from("\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u00023\n")])),
    }));
    const container = { exec } as unknown as Docker.Container;

    await expect(killStrayProcesses(container)).resolves.toBe(3);
    const script = (exec.mock.calls[0] as unknown as [{ Cmd: string[] }])[0].Cmd.at(-1)!;
    expect(script).toContain("os.getppid()");
    expect(script).toContain("/usr/local/bin/lightpanda");
    expect(script).toContain("/usr/bin/sleep");
    // A `timeout` or `python3` planted in the writable directories at the head of PATH never runs.
    const options = (exec.mock.calls[0] as unknown as [{ Cmd: string[]; Env: string[] }])[0];
    expect(options.Cmd.slice(0, 6)).toEqual(["/usr/bin/timeout", "--signal=KILL", "20", "/usr/bin/python3", "-I", "-c"]);
    expect(options.Env).toEqual(["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]);
  });

  it.skipIf(!PYTHON_AVAILABLE)("kills a process whose executable cannot be read and passes over one already gone", () => {
    // A fake /proc: the sweep reads it through the path it is given and kills through a recorder.
    const proc = mkdtempSync(join(tmpdir(), "osinara-proc-"));
    try {
      const process = (pid: number) => {
        mkdirSync(join(proc, String(pid)));
        return join(proc, String(pid), "exe");
      };
      symlinkSync("/usr/bin/sleep", process(1));
      symlinkSync("/usr/bin/sleep", process(10));
      symlinkSync("/usr/local/bin/lightpanda", process(11));
      symlinkSync("/tmp/miner", process(12));
      // readlink fails on it as on the exe of a non-dumpable process, whoever runs the test.
      writeFileSync(process(13), "");
      process(14);
      mkdirSync(join(proc, "self"));
      mkdirSync(join(proc, "20"));
      symlinkSync("/tmp/sweeper", join(proc, "20", "exe"));

      const output = execFileSync("python3", ["-I", "-c", `${STRAY_SWEEP_PYTHON}
import json, sys
killed = []
count = sweep(sys.argv[1], lambda pid, signal: killed.append(pid), {20})
print(json.dumps({"count": count, "killed": sorted(killed)}))
`, proc], { encoding: "utf8" });

      expect(JSON.parse(output)).toEqual({ count: 2, killed: [12, 13] });
    } finally {
      rmSync(proc, { force: true, recursive: true });
    }
  });

  it("throws when the sweep did not finish", async () => {
    const exec = vi.fn(async () => ({ inspect: vi.fn(async () => ({ ExitCode: 137 })), start: vi.fn(async () => Readable.from([])) }));
    await expect(killStrayProcesses({ exec } as unknown as Docker.Container)).rejects.toThrow("AGENT_SANDBOX_RUNNER_CLEANUP_FAILED");
  });
});

describe("createStartBarrier", () => {
  function run(startedAt: string) {
    return {
      inspect: vi.fn(async () => ({ Id: "sandbox-id", State: { Running: true, StartedAt: startedAt } })),
      stop: vi.fn(async () => undefined),
    } as unknown as Docker.Container & { stop: ReturnType<typeof vi.fn> };
  }

  it("applies once per run and makes a concurrent caller wait for it", async () => {
    let finish!: () => void;
    const apply = vi.fn(async (): Promise<void> => undefined).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const ready = createStartBarrier(apply);
    const container = run("2026-10-05T10:00:00Z");

    let secondDone = false;
    const first = ready(container);
    const second = ready(container).then(() => { secondDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondDone).toBe(false);
    finish();
    await Promise.all([first, second]);
    await ready(container);
    expect(apply).toHaveBeenCalledTimes(1);

    // A restart is a new run with a new namespace.
    await ready(run("2026-10-05T11:00:00Z"));
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("stops the container when the rules fail and applies again only on the next run", async () => {
    let stopped!: () => void;
    const apply = vi.fn().mockRejectedValueOnce(new Error("AGENT_SANDBOX_RUNNER_FIREWALL_FAILED: x")).mockResolvedValue(undefined);
    const ready = createStartBarrier(apply);
    const container = run("2026-10-05T10:00:00Z");
    const stopping = new Promise<void>((resolve) => { stopped = resolve; });
    container.stop.mockReturnValue(stopping);

    const failed = ready(container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // While the stop is under way the same run stays refused, with no second set of rules.
    const meanwhile = ready(container);
    stopped();
    await expect(failed).rejects.toThrow("AGENT_SANDBOX_RUNNER_FIREWALL_FAILED");
    await expect(meanwhile).rejects.toThrow("AGENT_SANDBOX_RUNNER_FIREWALL_FAILED");
    expect(apply).toHaveBeenCalledTimes(1);

    await expect(ready(run("2026-10-05T10:05:00Z"))).resolves.toBeUndefined();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("never forgets a run whose rules are still being laid", async () => {
    let finish!: () => void;
    const apply = vi.fn(async (_container: Docker.Container): Promise<void> => undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const ready = createStartBarrier(apply);
    const pending = { inspect: vi.fn(async () => ({ Id: "pending-id", State: { Running: true, StartedAt: "2026-10-05T10:00:00Z" } })) } as unknown as Docker.Container;
    const first = ready(pending);
    for (let index = 0; index < 2_100; index += 1) {
      await ready({ inspect: async () => ({ Id: `other-${index}`, State: { Running: true, StartedAt: "2026-10-05T10:00:00Z" } }) } as unknown as Docker.Container);
    }
    const again = ready(pending);
    finish();
    await Promise.all([first, again]);
    expect(apply.mock.calls.filter(([container]) => container === pending)).toHaveLength(1);
  });

  it("lays the rules closed: the default policies drop before the chains are refilled", async () => {
    const helper = { logs: vi.fn(), remove: vi.fn(async () => undefined), start: vi.fn(async () => undefined), wait: vi.fn(async () => ({ StatusCode: 0 })) };
    const docker = dockerWith(helper);
    await applyEgressFirewall(docker, "sandbox-image", containerWith("osinara_sandbox-egress"), "osinara");
    const script = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0]![0].Cmd.at(-1) as string;
    expect(script.indexOf("-P OUTPUT DROP")).toBeLessThan(script.indexOf("-F OSINARA-OUT"));
    expect(script).toContain("-P INPUT DROP");
  });
});
