/**
 * Network rules and stray processes of a sandbox.
 *
 * Constructs covered:
 * - The firewall runs in a short-lived helper in the sandbox's network namespace with NET_ADMIN
 *   (the sandbox never has it), allows only the proxy port, loopback and replies, and is
 *   skipped for a sandbox without network; a failed helper fails the start with a code.
 * - The stray-process cleanup kills everything but the placeholder and the reader's daemons,
 *   never itself or its timeout, and reports the count.
 * - Checked live on Docker (5 October 2026): proxy:3128 reachable, a neighbour sandbox and other
 *   ports not, DNS working, a `nohup` process gone after the command.
 */
import { Readable } from "node:stream";

import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { applyEgressFirewall, killStrayProcesses } from "./docker-sandbox-hardening.js";

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
    const exec = vi.fn(async () => ({ start: vi.fn(async () => Readable.from([Buffer.from("\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u00023\n")])) }));
    const container = { exec } as unknown as Docker.Container;

    await expect(killStrayProcesses(container)).resolves.toBe(3);
    const script = (exec.mock.calls[0] as unknown as [{ Cmd: string[] }])[0].Cmd.at(-1)!;
    expect(script).toContain("os.getppid()");
    expect(script).toContain("/usr/local/bin/lightpanda");
    expect(script).toContain("/usr/bin/sleep");
  });
});
