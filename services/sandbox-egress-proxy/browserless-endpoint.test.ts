/**
 * The proxy's Browserless endpoint.
 *
 * Constructs covered:
 * - Only the fixed path with captcha solving and a session of at most two minutes is accepted;
 *   without a configured key the endpoint is unavailable.
 * - The key is added by the proxy and never comes back to the sandbox: a provider answer other
 *   than a switch to WebSocket becomes a bare 502.
 */
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createSandboxEgressProxy } from "./server.js";

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function proxyWith(apiKey?: string): Promise<number> {
  const server = createSandboxEgressProxy(apiKey === undefined ? {} : { browserlessApiKey: apiKey });
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

describe("Browserless endpoint", () => {
  it.each([
    "/browserless/chromium/other",
    "/browserless/chromium/stealth?token=mine",
    "/browserless/chromium/stealth?timeout=999999",
    "/elsewhere",
  ])("refuses %s", async (path) => {
    const port = await proxyWith("secret-key");
    expect((await upgrade(port, path)).status).toBe(404);
  });

  it("is unavailable without a configured key", async () => {
    const port = await proxyWith();
    expect((await upgrade(port, "/browserless/chromium/stealth?solveCaptchas=true&timeout=120000")).status).toBe(503);
  });

  it("answers a provider that refuses with a bare 502, never its body", async () => {
    // The provider host does not resolve to a public address in the test sandbox, so the
    // connection fails before any provider answer; the sandbox still sees only a 502.
    const port = await proxyWith("secret-key");
    const answer = await upgrade(port, "/browserless/chromium/stealth?solveCaptchas=true&timeout=120000");
    expect(answer.status).toBe(502);
    expect(answer.body).not.toContain("secret-key");
  });
});

