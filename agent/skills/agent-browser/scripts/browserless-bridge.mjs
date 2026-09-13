// A loopback CDP bridge: agent-browser 0.36 does not proxy its WebSocket transport.
// Only the fixed Browserless host leaves the sandbox, through its public-only egress proxy.
import { createServer, request } from "node:http";
import { connect as connectTls } from "node:tls";
import { once } from "node:events";

export const BRIDGE_PORT = 17373;
const HOST = "production-sfo.browserless.io";
const LIFETIME_MS = 120_000;

export async function connectThroughProxy(proxyUrl) {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:" || proxy.username || proxy.password) {
    throw new Error("AGENT_BROWSERLESS_PROXY_INVALID");
  }
  return await new Promise((resolve, reject) => {
    const req = request({
      hostname: proxy.hostname, port: proxy.port || 80, method: "CONNECT",
      path: `${HOST}:443`, headers: { Host: `${HOST}:443` },
    });
    const deadline = setTimeout(() => req.destroy(new Error("AGENT_BROWSERLESS_PROXY_TIMEOUT")), 10_000);
    req.on("error", () => {
      clearTimeout(deadline);
      reject(new Error("AGENT_BROWSERLESS_PROXY_FAILED"));
    });
    req.on("connect", (res, socket, head) => {
      clearTimeout(deadline);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error("AGENT_BROWSERLESS_PROXY_REJECTED"));
        return;
      }
      if (head.length) socket.unshift(head);
      const secure = connectTls({ socket, servername: HOST, rejectUnauthorized: true });
      secure.setTimeout(10_000, () => secure.destroy(new Error("TLS timeout")));
      secure.once("secureConnect", () => {
        secure.setTimeout(0);
        resolve(secure);
      });
      secure.on("error", () => reject(new Error("AGENT_BROWSERLESS_TLS_FAILED")));
    });
    req.end();
  });
}

export async function startBridge({
  apiKey,
  port = BRIDGE_PORT,
  lifetimeMs = LIFETIME_MS,
  connectUpstream = () => connectThroughProxy(process.env.HTTPS_PROXY),
}) {
  if (!apiKey?.trim()) throw new Error("AGENT_BROWSERLESS_NOT_CONFIGURED");
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
      const query = new URLSearchParams({ token: apiKey, solveCaptchas: "true", timeout: String(LIFETIME_MS) });
      const upstream = request({
        hostname: HOST, port: 443, path: `/chromium/stealth?${query}`,
        createConnection: () => socket,
        headers: {
          Host: HOST, Connection: "Upgrade", Upgrade: "websocket",
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
