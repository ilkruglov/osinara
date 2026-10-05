/**
 * Network rules and stray processes of a sandbox.
 *
 * Constructs covered:
 * - The firewall runs in a short-lived helper in the sandbox's network namespace with NET_ADMIN
 *   (the sandbox never has it), allows only the proxy port, loopback and replies, and is
 *   skipped for a sandbox without network; a failed helper fails the start with a code.
 * - The stray-process cleanup kills everything but the placeholder and the reader's daemons,
 *   never itself or its timeout, and reports the count; it runs the system's own tools by
 *   absolute path with the system PATH and isolated Python, and a failed sweep throws.
 * - `createStartBarrier`: one application per container run, awaited by everyone who arrives
 *   while it is laid; a failure stops the container and the next run applies again.
 * - Checked live on Docker (5 October 2026): proxy:3128 reachable, a neighbour sandbox and other
 *   ports not, DNS working, a `nohup` process gone after the command.
 */
import { Readable } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { applyEgressFirewall, createStartBarrier, killStrayProcesses } from "./docker-sandbox-hardening.js";

function containerWith(networkMode: string) {
  return {
    inspect: vi.fn(async () => ({ HostConfig: { NetworkMode: networkMode }, Id: "sandbox-id", Name: "/osinara-sandbox-x", NetworkSettings: { Networks: { egress: { IPAddress: "172.20.0.5" } } } })),
  } as unknown as Docker.Container;
}

describe("applyEgressFirewall", () => {
  it("lays the rules from a NET_ADMIN helper in the sandbox's namespace", async () => {
    const helper = { logs: vi.fn(), remove: vi.fn(async () => undefined), start: vi.fn(async () => undefined), wait: vi.fn(async () => ({ StatusCode: 0 })) };
    const docker = { createContainer: vi.fn(async () => helper) } as unknown as Docker;

    await applyEgressFirewall(docker, "sandbox-image", containerWith("osinara_sandbox-egress"), "osinara");

    const options = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(options.HostConfig).toMatchObject({ CapAdd: ["NET_ADMIN", "NET_RAW"], CapDrop: ["ALL"], NetworkMode: "container:sandbox-id" });
    const script = options.Cmd.at(-1) as string;
    expect(script).toContain("--dport 3128");
    expect(script).toContain("OSINARA-IN -j DROP");
    expect(script).toContain("OSINARA-OUT -j REJECT");
    expect(helper.remove).toHaveBeenCalled();
  });

  it("skips a sandbox without network and fails a start whose rules did not apply", async () => {
    const docker = { createContainer: vi.fn() } as unknown as Docker;
    await applyEgressFirewall(docker, "image", containerWith("none"), "osinara");
    expect(docker.createContainer).not.toHaveBeenCalled();

    const helper = { logs: vi.fn(async () => Buffer.from("iptables: not found")), remove: vi.fn(async () => undefined), start: vi.fn(async () => undefined), wait: vi.fn(async () => ({ StatusCode: 1 })) };
    const failing = { createContainer: vi.fn(async () => helper) } as unknown as Docker;
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

  it("lays the rules closed: the default policies drop before the chains are refilled", async () => {
    const helper = { logs: vi.fn(), remove: vi.fn(async () => undefined), start: vi.fn(async () => undefined), wait: vi.fn(async () => ({ StatusCode: 0 })) };
    const docker = { createContainer: vi.fn(async () => helper) } as unknown as Docker;
    await applyEgressFirewall(docker, "sandbox-image", containerWith("osinara_sandbox-egress"), "osinara");
    const script = (docker.createContainer as ReturnType<typeof vi.fn>).mock.calls[0]![0].Cmd.at(-1) as string;
    expect(script.indexOf("-P OUTPUT DROP")).toBeLessThan(script.indexOf("-F OSINARA-OUT"));
    expect(script).toContain("-P INPUT DROP");
  });
});
