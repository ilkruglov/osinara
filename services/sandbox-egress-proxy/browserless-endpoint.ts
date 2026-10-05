/**
 * The proxy's Browserless endpoint: the only way a sandbox reaches the cloud browser.
 *
 * Export:
 * - `handleBrowserlessUpgrade`: a WebSocket upgrade to `/browserless/chromium/stealth`, relayed to
 *   the provider over TLS with the API key added here.
 *
 * Key construct:
 * - The key used to sit in every trusted sandbox's environment, so any command could read it and
 *   send it anywhere (security review, 5 October 2026). Now only the proxy has it. The endpoint
 *   accepts one fixed path and two parameters (captcha solving, a session of at most two
 *   minutes), resolves the provider through the same public-only resolver, and answers only a
 *   successful switch to WebSocket: any other provider answer becomes a bare 502, since provider
 *   bodies and URLs may echo the key.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";

const PROVIDER_HOST = "production-sfo.browserless.io";
const PATH = "/browserless/chromium/stealth";
const MAX_SESSION_MS = 120_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function handleBrowserlessUpgrade(input: {
  apiKey: string | undefined;
  clientSocket: Duplex;
  head: Buffer;
  onClosed: (bytesUp: number, bytesDown: number, ms: number) => void;
  request: IncomingMessage;
  resolve: (hostname: string, port: number) => Promise<{ address: string }>;
}): void {
  const { clientSocket, request } = input;
  clientSocket.on("error", () => clientSocket.destroy());
  const url = new URL(request.url ?? "/", "http://sandbox-egress-proxy");
  const key = request.headers["sec-websocket-key"];
  const timeout = Number(url.searchParams.get("timeout") ?? MAX_SESSION_MS);
  const allowedParameters = [...url.searchParams.keys()].every((name) => name === "solveCaptchas" || name === "timeout");
  if (url.pathname !== PATH || request.method !== "GET" || typeof key !== "string" || !allowedParameters ||
    !Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_SESSION_MS) {
    refuse(clientSocket, 404, "Not Found");
    return;
  }
  if (!input.apiKey) {
    refuse(clientSocket, 503, "Service Unavailable");
    return;
  }
  const query = new URLSearchParams({
    solveCaptchas: url.searchParams.get("solveCaptchas") === "true" ? "true" : "false",
    timeout: String(timeout),
    token: input.apiKey,
  });
  const startedAt = Date.now();
  void (async () => {
    const target = await input.resolve(PROVIDER_HOST, 443);
    const upstream = connectTls({ host: target.address, port: 443, rejectUnauthorized: true, servername: PROVIDER_HOST });
    const fail = () => {
      upstream.destroy();
      if (!clientSocket.destroyed) refuse(clientSocket, 502, "Bad Gateway");
    };
    const deadline = setTimeout(fail, HANDSHAKE_TIMEOUT_MS);
    upstream.once("error", () => {
      clearTimeout(deadline);
      fail();
    });
    clientSocket.once("close", () => upstream.destroy());
    upstream.once("secureConnect", () => {
      upstream.write(
        `GET /chromium/stealth?${query} HTTP/1.1\r\nHost: ${PROVIDER_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key.replace(/[\r\n]/gu, "")}\r\n\r\n`,
      );
    });
    // Only a 101 passes to the sandbox; the head is read whole before anything is forwarded.
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_RESPONSE_HEAD_BYTES) fail();
        return;
      }
      upstream.off("data", onData);
      clearTimeout(deadline);
      const statusLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      if (!statusLine.startsWith("HTTP/1.1 101 ")) {
        fail();
        return;
      }
      const accept = /\r\nsec-websocket-accept:\s*([^\r\n]+)/iu.exec(head.subarray(0, end).toString("latin1"))?.[1] ?? "";
      clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const rest = head.subarray(end + 4);
      if (rest.length > 0) clientSocket.write(rest);
      if (input.head.length > 0) upstream.write(input.head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      const closeAll = () => {
        clientSocket.destroy();
        upstream.destroy();
      };
      upstream.once("close", closeAll);
      clientSocket.once("close", closeAll);
      upstream.once("close", () => input.onClosed(upstream.bytesWritten, upstream.bytesRead, Date.now() - startedAt));
    };
    upstream.on("data", onData);
  })().catch(() => {
    if (!clientSocket.destroyed) refuse(clientSocket, 502, "Bad Gateway");
  });
}
