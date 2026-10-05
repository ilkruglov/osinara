/**
 * The proxy's Browserless endpoint.
 *
 * Constructs covered:
 * - Only the fixed path with captcha solving, a session of at most two minutes and a one-time
 *   session id is accepted; without a configured key the endpoint is unavailable.
 * - The key is added by the proxy and never comes back to the sandbox: a provider answer other
 *   than a switch to WebSocket becomes a bare 502.
 * - One cloud browser per sandbox at a time (409 on a second), each session id once (409 on a
 *   reconnect); the slot is held for the life of the operation: a refused client that keeps its
 *   half open does not hold it, and a client gone during the DNS lookup is never sent on.
 */
import { once } from "node:events";
import { request } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionClaims } from "./browserless-endpoint.js";
import { createSandboxEgressProxy, type ResolvedTarget } from "./server.js";

// No test here reaches the provider; each TLS attempt is counted and goes nowhere.
const tls = vi.hoisted(() => ({ attempts: 0 }));
vi.mock("node:tls", () => ({
  connect: () => {
    tls.attempts += 1;
    return Object.assign(new EventEmitter(), { destroy: () => undefined, off: () => undefined, write: () => true });
  },
}));

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

let sessions = 0;
const sessionId = () => (sessions += 1).toString(16).padStart(32, "0");
const stealth = (session = sessionId()) => `/browserless/chromium/stealth?solveCaptchas=true&timeout=120000&session=${session}`;

async function proxyWith(
  apiKey?: string,
  resolveTarget?: (hostname: string, port: number) => Promise<ResolvedTarget>,
): Promise<number> {
  const server = createSandboxEgressProxy({
    ...(apiKey === undefined ? {} : { browserlessApiKey: apiKey }),
    ...(resolveTarget ? { resolveTarget } : {}),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function upgrade(port: number, path: string): Promise<{ status: number; body: string }> {
  const req = request({
    headers: { Connection: "Upgrade", "Sec-WebSocket-Key": "dGVzdA==", "Sec-WebSocket-Version": "13", Upgrade: "websocket" },
    hostname: "127.0.0.1",
    path,
    port,
  });
  req.end();
  const [response] = await once(req, "response") as [import("node:http").IncomingMessage];
  let body = "";
  for await (const chunk of response) body += chunk;
  return { body, status: response.statusCode ?? 0 };
}

/** A raw client: writes the handshake and keeps its own half open unless told otherwise. */
function rawUpgrade(port: number, path: string): Socket {
  const socket = connect({ allowHalfOpen: true, host: "127.0.0.1", port });
  socket.on("error", () => undefined);
  socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  return socket;
}

async function firstAnswer(socket: Socket, waitMs = 300): Promise<string> {
  return await Promise.race([
    once(socket, "data").then(([data]) => (data as Buffer).toString("latin1").split("\r\n")[0]!),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), waitMs)),
  ]);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<ResolvedTarget>(() => undefined);

describe("Browserless endpoint", () => {
  it.each([
    "/browserless/chromium/other",
    "/browserless/chromium/stealth?token=mine",
    "/browserless/chromium/stealth?timeout=999999",
    "/browserless/chromium/stealth?solveCaptchas=true&timeout=120000",
    "/browserless/chromium/stealth?session=short",
    "/elsewhere",
  ])("refuses %s", async (path) => {
    const port = await proxyWith("secret-key");
    expect((await upgrade(port, path)).status).toBe(404);
  });

  it("is unavailable without a configured key", async () => {
    const port = await proxyWith();
    expect((await upgrade(port, stealth())).status).toBe(503);
  });

  it("answers a provider that refuses with a bare 502, never its body", async () => {
    const port = await proxyWith("secret-key", async () => { throw new Error("AGENT_SANDBOX_EGRESS_DNS_FAILED"); });
    const answer = await upgrade(port, stealth());
    expect(answer.status).toBe(502);
    expect(answer.body).not.toContain("secret-key");
  });

  it("keeps one cloud browser per sandbox at a time and opens a session id once", async () => {
    // The provider never answers here, so a session stays open while the next one asks.
    const port = await proxyWith("secret-key", never);
    const session = sessionId();
    const first = rawUpgrade(port, stealth(session));
    await pause(50);
    const second = rawUpgrade(port, stealth());
    expect(await firstAnswer(second)).toBe("HTTP/1.1 409 Conflict");
    second.destroy();

    first.destroy();
    await pause(50);
    // agent-browser reconnecting on its own after a dropped socket: the same id is refused.
    const reconnect = rawUpgrade(port, stealth(session));
    expect(await firstAnswer(reconnect)).toBe("HTTP/1.1 409 Conflict");
    reconnect.destroy();
    await pause(50);

    // A new open, a new id: admitted, waiting for the provider like the first.
    const next = rawUpgrade(port, stealth());
    expect(await firstAnswer(next)).toBe("pending");
    next.destroy();
  });

  it("frees the slot of a refused client that keeps its half open", async () => {
    const port = await proxyWith();
    const refused = rawUpgrade(port, "/browserless/chromium/stealth?session=short");
    expect(await firstAnswer(refused)).toBe("HTTP/1.1 404 Not Found");
    await pause(50);
    const next = rawUpgrade(port, stealth());
    expect(await firstAnswer(next)).toBe("HTTP/1.1 503 Service Unavailable");
    refused.destroy();
    next.destroy();
  });

  it("never asks the provider for a client gone during the DNS lookup", async () => {
    tls.attempts = 0;
    let resolved = 0;
    const port = await proxyWith("secret-key", async (hostname, targetPort) => {
      await pause(100);
      resolved += 1;
      return { address: "127.0.0.1", family: 4, hostname, port: targetPort };
    });
    const gone = rawUpgrade(port, stealth());
    await pause(20);
    gone.destroy();
    await pause(200);
    expect(resolved).toBe(1);
    expect(tls.attempts).toBe(0);

    // And its slot is free again.
    const next = rawUpgrade(port, stealth());
    const answer = await firstAnswer(next, 400);
    expect(answer).not.toBe("HTTP/1.1 409 Conflict");
    next.destroy();
  });

  it("forgets only expired session ids and refuses new ones rather than a live id when full", () => {
    let now = 0;
    const claim = createSessionClaims(() => now, 3);
    expect(claim("a")).toBe(true);
    expect(claim("b")).toBe(true);
    expect(claim("c")).toBe(true);
    expect(claim("d")).toBe(false);
    expect(claim("a")).toBe(false);
    now = 240_000;
    expect(claim("a")).toBe(true);
    expect(claim("a")).toBe(false);
  });
});
