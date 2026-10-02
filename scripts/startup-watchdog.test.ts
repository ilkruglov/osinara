/**
 * Startup watchdog of the agent container.
 *
 * Constructs covered:
 * - A server that is alive but never answers health gets SIGTERM at the deadline.
 * - A server whose health answers is left alone and the watchdog exits.
 * - The watchdog exits on its own when the server is gone.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { watchStartup } from "./startup-watchdog.ts";

const children: ChildProcess[] = [];

function idleServer(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

describe("startup watchdog", () => {
  it("stops a live server that never becomes healthy", async () => {
    const server = idleServer();
    const exited = once(server, "exit");
    const outcome = await watchStartup({
      deadlineMs: 300,
      healthUrl: "http://127.0.0.1:9/eve/v1/health",
      killAfterMs: 1_000,
      pollMs: 50,
      serverPid: server.pid!,
    });

    expect(outcome).toBe("stopped");
    expect((await exited)[1]).toBe("SIGTERM");
  });

  it("leaves a healthy server running", async () => {
    const health = createServer((_request, response) => response.end("ok"));
    await once(health.listen(0, "127.0.0.1"), "listening");
    const server = idleServer();
    try {
      const outcome = await watchStartup({
        deadlineMs: 2_000,
        healthUrl: `http://127.0.0.1:${(health.address() as AddressInfo).port}/eve/v1/health`,
        killAfterMs: 1_000,
        pollMs: 50,
        serverPid: server.pid!,
      });

      expect(outcome).toBe("healthy");
      expect(server.exitCode).toBeNull();
      expect(server.signalCode).toBeNull();
    } finally {
      health.close();
    }
  });

  it("gives up when the server process is gone", async () => {
    const server = idleServer();
    server.kill("SIGKILL");
    await once(server, "exit");

    await expect(watchStartup({
      deadlineMs: 2_000,
      healthUrl: "http://127.0.0.1:9/eve/v1/health",
      killAfterMs: 1_000,
      pollMs: 50,
      serverPid: server.pid!,
    })).resolves.toBe("server-gone");
  });
});
