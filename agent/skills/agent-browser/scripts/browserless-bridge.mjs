// A loopback CDP bridge: agent-browser 0.36 does not proxy its WebSocket transport.
// Only the egress proxy's fixed Browserless endpoint is reached; the proxy adds the key.
import { createServer, request } from "node:http";
import { connect as connectTcp } from "node:net";
import { once } from "node:events";

export const BRIDGE_PORT = 17373;
const LIFETIME_MS = 120_000;

// The API key never enters the sandbox: the egress proxy adds it on its own Browserless endpoint
// (security review, 5 October 2026: any process in the sandbox could read and send the key).
export async function connectToProxy(proxyUrl) {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:" || proxy.username || proxy.password) {
    throw new Error("AGENT_BROWSERLESS_PROXY_INVALID");
  }
  return await new Promise((resolve, reject) => {
    const socket = connectTcp({ host: proxy.hostname, port: Number(proxy.port || 80) });
    const deadline = setTimeout(() => socket.destroy(new Error("AGENT_BROWSERLESS_PROXY_TIMEOUT")), 10_000);
    socket.once("connect", () => {
      clearTimeout(deadline);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(deadline);
      reject(new Error("AGENT_BROWSERLESS_PROXY_FAILED"));
    });
  });
}

export async function startBridge({
  available,
  port = BRIDGE_PORT,
  lifetimeMs = LIFETIME_MS,
  connectUpstream = () => connectToProxy(process.env.HTTPS_PROXY),
}) {
  if (!available) throw new Error("AGENT_BROWSERLESS_NOT_CONFIGURED");
  const sockets = new Set();
  let connected = false;
  let used = false;
  let closed = false;
  let timer;
  const expiresAt = Date.now() + Math.min(lifetimeMs, LIFETIME_MS);
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close();
  };
  const track = (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ service: "osinara-browserless", connected, expiresAt }));
    } else if (req.method === "POST" && req.url === "/close") {
      res.end("closed");
      res.once("finish", close);
    } else res.writeHead(404).end();
  });
  server.on("upgrade", (incoming, client, head) => {
    track(client);
    if (incoming.url !== "/cdp" || used || closed) {
      client.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // A reconnect must not silently create another billable browser.
    used = true;
    const fail = () => {
      const body = "AGENT_BROWSERLESS_UPSTREAM_FAILED";
      client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    };
    void (async () => {
      const socket = await connectUpstream();
      if (closed || client.destroyed) { socket.destroy(); return; }
      track(socket);
      client.once("close", () => socket.destroy());
      const query = new URLSearchParams({ solveCaptchas: "true", timeout: String(LIFETIME_MS) });
      const upstream = request({
        path: `/browserless/chromium/stealth?${query}`,
        createConnection: () => socket,
        headers: {
          Host: "sandbox-egress-proxy", Connection: "Upgrade", Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": incoming.headers["sec-websocket-key"] ?? "",
        },
      });
      const handshakeTimer = setTimeout(() => upstream.destroy(), 10_000);
      upstream.on("error", () => { clearTimeout(handshakeTimer); fail(); });
      upstream.on("response", (res) => {
        clearTimeout(handshakeTimer);
        res.resume();
        // Never forward provider response bodies or URLs: they may contain the API token.
        fail();
      });
      upstream.on("upgrade", (res, remote, remoteHead) => {
        clearTimeout(handshakeTimer);
        connected = true;
        client.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          `Sec-WebSocket-Accept: ${res.headers["sec-websocket-accept"] ?? ""}\r\n\r\n`);
        if (remoteHead.length) client.write(remoteHead);
        if (head.length) remote.write(head);
        remote.pipe(client);
        client.pipe(remote);
        remote.once("close", close);
        client.once("close", close);
      });
      upstream.end();
    })().catch(fail);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  timer = setTimeout(close, Math.max(1, expiresAt - Date.now()));
  return { port: server.address().port, server, close };
}
