import { createServer, request } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { connectToProxy, startBridge } from "../agent/skills/agent-browser/scripts/browserless-bridge.mjs";
import { browserEnvironment } from "../agent/skills/agent-browser/scripts/browserless.mjs";

const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function upgrade(port) {
  return request({
    hostname: "127.0.0.1", port, path: "/cdp",
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "test-key", "Sec-WebSocket-Version": "13" },
  });
}

describe("Browserless fallback", () => {
  it("reports an unavailable cloud browser without starting a session", async () => {
    const env = { ...process.env };
    delete env.BROWSERLESS_AVAILABLE;
    await expect(promisify(execFile)(process.execPath, [
      "agent/skills/agent-browser/scripts/browserless.mjs", "open", "https://example.com",
    ], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("AGENT_BROWSERLESS_NOT_CONFIGURED") });
  });

  // 2 October 2026: the cloud helper accepted click and fill, so a public form could be sent with
  // the person's phone past the confirmation gate of browser_act.
  it("reads pages but refuses every page action", async () => {
    const env = { ...process.env };
    delete env.BROWSERLESS_API_KEY;
    for (const command of ["click", "fill", "type", "press", "select", "check", "uncheck", "hover"]) {
      await expect(promisify(execFile)(process.execPath, [
        "agent/skills/agent-browser/scripts/browserless.mjs", command, "@e1",
      ], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("AGENT_BROWSERLESS_COMMAND_FORBIDDEN") });
    }
  });

  it("reaches only the egress proxy, never the provider, and refuses a proxy URL with credentials", async () => {
    await expect(connectToProxy("http://user:pass@127.0.0.1:1")).rejects.toThrow("AGENT_BROWSERLESS_PROXY_INVALID");
    await expect(connectToProxy("http://127.0.0.1:1")).rejects.toThrow("AGENT_BROWSERLESS_PROXY_FAILED");
  });

  it("isolates cloud state from local restore, profiles, proxy and credentials", () => {
    const env = browserEnvironment({
      HOME: "/tools/personal/home", PATH: "/usr/bin", BROWSERLESS_API_KEY: "secret",
      AGENT_BROWSER_RESTORE: "osinara", AGENT_BROWSER_PROFILE: "/private-profile",
      AGENT_BROWSER_PROXY: "http://sandbox-egress-proxy:3128", AGENT_BROWSER_PROVIDER: "other",
    });
    expect(env.HOME).toBe("/tmp/osinara-browserless-home");
    expect(env.AGENT_BROWSER_SESSION).toBe("osinara-cloud");
    expect(env.PATH).toBe("/usr/bin");
    for (const key of ["BROWSERLESS_API_KEY", "AGENT_BROWSER_RESTORE", "AGENT_BROWSER_PROFILE", "AGENT_BROWSER_PROXY", "AGENT_BROWSER_PROVIDER"]) {
      expect(env[key]).toBeUndefined();
    }
  });

  // The key stays in the egress proxy (security review, 5 October 2026); the bridge asks the
  // proxy's endpoint for autosolve and the free-plan deadline and sends no token.
  it("asks the proxy endpoint for autosolve and a free-plan deadline without a key while relaying bytes", async () => {
    const upstream = createServer();
    const upstreamPort = await listen(upstream);
    let requested;
    upstream.on("upgrade", (req, socket, head) => {
      requested = new URL(req.url, "https://browserless.invalid");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      socket.on("data", (data) => socket.write(data));
      if (head.length) socket.write(head);
      cleanup.push(() => socket.destroy());
    });
    const bridge = await startBridge({ available: true, port: 0, connectUpstream: async () => connect(upstreamPort, "127.0.0.1") });
    cleanup.push(() => bridge.close());
    const req = upgrade(bridge.port);
    req.end();
    const [, socket] = await once(req, "upgrade");
    cleanup.push(() => socket.destroy());
    const received = once(socket, "data");
    socket.write("cdp-payload");
    expect(String((await received)[0])).toBe("cdp-payload");
    expect(requested.pathname).toBe("/browserless/chromium/stealth");
    expect(requested.searchParams.has("token")).toBe(false);
    expect(requested.searchParams.get("solveCaptchas")).toBe("true");
    expect(requested.searchParams.get("timeout")).toBe("120000");
    expect(requested.searchParams.has("proxy")).toBe(false);
  });

  it("redacts upstream failures and does not retry a rejected cloud connection", async () => {
    const upstream = createServer((_req, res) => res.writeHead(401).end("token=secret"));
    const upstreamPort = await listen(upstream);
    let connects = 0;
    const bridge = await startBridge({ available: true, port: 0, connectUpstream: async () => {
      connects++;
      return connect(upstreamPort, "127.0.0.1");
    } });
    cleanup.push(() => bridge.close());
    const req = upgrade(bridge.port);
    req.end();
    const [res] = await once(req, "response");
    let body = "";
    for await (const data of res) body += data;
    expect(res.statusCode).toBe(502);
    expect(body).toContain("AGENT_BROWSERLESS_UPSTREAM_FAILED");
    expect(body).not.toContain("secret");
    expect(connects).toBe(1);
  });

  it("closes an idle bridge when its fixed lifetime expires", async () => {
    const bridge = await startBridge({ available: true, port: 0, lifetimeMs: 30 });
    cleanup.push(() => bridge.close());
    await once(bridge.server, "close");
    expect(bridge.server.listening).toBe(false);
  });
});
