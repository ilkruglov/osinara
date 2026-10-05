/**
 * Public-internet-only HTTP CONNECT proxy for trusted sandboxes.
 *
 * Exports:
 * - `bindTunnelLifecycle`: prevents either side of a CONNECT tunnel from becoming orphaned.
 * - `connectWithDeadline`: bounds TCP establishment without timing out an established idle tunnel.
 * - `createSandboxEgressProxy`: creates the internal proxy server.
 *
 * Security invariants:
 * - DNS is resolved at the proxy and the validated IP is pinned for the connection.
 * - Private/reserved destinations and ports other than HTTP(S) are rejected.
 * - Proxy credentials and hop-by-hop headers are never forwarded.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { createSessionClaims, handleBrowserlessUpgrade } from "./browserless-endpoint.js";
import { createEgressLedger, type EgressLedger, type EgressMeter, type EgressTarget } from "./egress-ledger.js";
import { resolvePublicInternetAddress } from "./public-dns-resolver.js";

const ALLOWED_PORTS = new Set([80, 443]);
const CONNECT_TIMEOUT_MS = 15_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ResolvedTarget {
  address: string;
  family: 4;
  hostname: string;
  port: number;
}

type ConnectPhase = "connect" | "request" | "resolution" | "tunnel";

export function bindTunnelLifecycle(clientSocket: Duplex, upstream: Socket): void {
  let upstreamTerminated = upstream.destroyed;
  let clientTerminated = clientSocket.destroyed || clientSocket.writableEnded;
  const destroyUpstream = () => {
    if (upstreamTerminated || upstream.destroyed) return;
    upstreamTerminated = true;
    upstream.destroy();
  };
  const endClient = () => {
    if (clientTerminated || clientSocket.destroyed || clientSocket.writableEnded) return;
    clientTerminated = true;
    clientSocket.end();
  };
  clientSocket.once("error", destroyUpstream);
  clientSocket.once("close", destroyUpstream);
  upstream.once("close", endClient);
}

export function connectWithDeadline(
  createSocket: () => Socket,
  timeoutMilliseconds: number,
): Socket {
  const socket = createSocket();
  const deadline = setTimeout(() => socket.destroy(
    new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: CONNECT timed out before establishment"),
  ), timeoutMilliseconds);
  deadline.unref();
  const clearDeadline = () => clearTimeout(deadline);
  socket.once("connect", clearDeadline);
  socket.once("error", clearDeadline);
  socket.once("close", clearDeadline);
  return socket;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || !ALLOWED_PORTS.has(port)) {
    throw new Error("AGENT_SANDBOX_EGRESS_PORT_FORBIDDEN: Only ports 80 and 443 are allowed");
  }
  return port;
}

async function resolvePublicTarget(hostname: string, port: number): Promise<ResolvedTarget> {
  // Resolve outside host VPN fake-IP DNS, then pin the validated address for this connection.
  const publicAddress = await resolvePublicInternetAddress(hostname);
  return { ...publicAddress, hostname, port };
}

function filteredHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function rejectSocket(socket: Duplex, status: number, message: string): void {
  // Destroyed once the answer is out: a client that keeps its half open must not hold the socket.
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}

function guardClientSocket(socket: Duplex, phase: () => ConnectPhase): () => boolean {
  let unavailable = socket.destroyed;
  // Browser cancellation commonly surfaces as EPIPE while a CONNECT tunnel is being piped.
  // The socket is request-scoped, so closing it must never terminate the shared proxy process.
  socket.on("error", (error: NodeJS.ErrnoException) => {
    unavailable = true;
    console.error("Sandbox CONNECT client socket failed", {
      code: error.code ?? "AGENT_SANDBOX_EGRESS_CLIENT_SOCKET_FAILED",
      errorName: error.name,
      phase: phase(),
    });
  });
  socket.once("close", () => {
    unavailable = true;
  });
  return () => unavailable;
}

/** Counts each chunk as it passes; past the day's budget every stream of the connection closes. */
function meterChunks(meter: EgressMeter, direction: "down" | "up", streams: readonly { destroy(): unknown }[]) {
  return (chunk: Buffer) => {
    if (!meter.add(direction, chunk.byteLength)) for (const stream of streams) stream.destroy();
  };
}

/** The sandbox's address on the egress network (the Duplex of CONNECT and upgrade is a socket). */
function clientAddress(socket: Duplex | Socket): string {
  return ((socket as Socket).remoteAddress ?? "unknown").replace(/^::ffff:/u, "");
}

export function createSandboxEgressProxy(options: {
  browserlessApiKey?: string;
  ledger?: EgressLedger;
  /** The public-only resolver; a test points it at a local server. */
  resolveTarget?: (hostname: string, port: number) => Promise<ResolvedTarget>;
} = {}) {
  const ledger = options.ledger ?? createEgressLedger();
  const resolveTarget = options.resolveTarget ?? resolvePublicTarget;
  const server = createServer((incoming, outgoing) => {
    const meter = ledger.open(clientAddress(incoming.socket));
    if (!meter) {
      outgoing.writeHead(429);
      outgoing.end("AGENT_SANDBOX_EGRESS_DAILY_LIMIT: Daily egress volume reached\n");
      return;
    }
    let logged: EgressTarget | null = null;
    outgoing.once("close", () => {
      if (logged) meter.close(logged);
    });
    void (async () => {
      const targetUrl = new URL(incoming.url ?? "");
      if (targetUrl.protocol !== "http:" || targetUrl.username || targetUrl.password) {
        throw new Error("AGENT_SANDBOX_EGRESS_URL_FORBIDDEN: Only credential-free HTTP URLs are allowed");
      }
      const port = parsePort(targetUrl.port || "80");
      const target = await resolveTarget(targetUrl.hostname, port);
      logged = { host: target.hostname, kind: "http", port };
      const upstream = httpRequest({
        family: target.family,
        headers: { ...filteredHeaders(incoming.headers), host: targetUrl.host },
        host: target.address,
        method: incoming.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        port: target.port,
        timeout: CONNECT_TIMEOUT_MS,
      }, (upstreamResponse) => {
        outgoing.writeHead(
          upstreamResponse.statusCode ?? 502,
          filteredHeaders(upstreamResponse.headers),
        );
        upstreamResponse.on("data", meterChunks(meter, "down", [upstream, outgoing]));
        upstreamResponse.pipe(outgoing);
      });
      upstream.on("timeout", () => upstream.destroy(
        new Error("AGENT_SANDBOX_EGRESS_TIMEOUT: Upstream connection timed out"),
      ));
      upstream.on("error", (error) => {
        console.error("Sandbox HTTP egress failed", { error, hostname: target.hostname, port });
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end("AGENT_SANDBOX_EGRESS_FAILED: Public destination request failed\n");
      });
      // Counted where it is forwarded: a listener attached before the DNS lookup drained the body
      // before the pipe existed, and the upstream got none of it (Codex review, 5 October 2026).
      incoming.on("data", meterChunks(meter, "up", [upstream, outgoing]));
      incoming.pipe(upstream);
    })().catch((error: unknown) => {
      console.error("Sandbox HTTP egress rejected", { error, url: incoming.url });
      if (!outgoing.headersSent) outgoing.writeHead(403);
      outgoing.end("AGENT_SANDBOX_EGRESS_FORBIDDEN: Destination is not allowed\n");
    });
  });

  // The Browserless endpoint: agent-browser in the sandbox connects here without a key, the proxy adds it.
  // One cloud browser per sandbox at a time, and each helper session id opens one only once: a
  // reconnect must not quietly start another billable browser (the sandbox's one-shot bridge
  // used to refuse it; the bridge is gone).
  const browserlessClients = new Set<string>();
  const claimSession = createSessionClaims();
  server.on("upgrade", (request, clientSocket, head) => {
    const client = clientAddress(clientSocket);
    // The server keeps sockets half-open: a sandbox that hung up would otherwise hold its slot.
    clientSocket.once("end", () => clientSocket.destroy());
    if (browserlessClients.has(client)) {
      rejectSocket(clientSocket, 409, "Conflict");
      return;
    }
    const meter = ledger.open(client);
    if (!meter) {
      rejectSocket(clientSocket, 429, "Too Many Requests");
      return;
    }
    browserlessClients.add(client);
    handleBrowserlessUpgrade({
      apiKey: options.browserlessApiKey,
      claimSession,
      clientSocket,
      head,
      meter,
      onFinished: () => browserlessClients.delete(client),
      request,
      resolve: resolveTarget,
    });
  });

  server.on("connect", (request, clientSocket, initialData) => {
    let phase: ConnectPhase = "request";
    const meter = ledger.open(clientAddress(clientSocket));
    if (!meter) {
      rejectSocket(clientSocket, 429, "Too Many Requests");
      return;
    }
    const clientUnavailable = guardClientSocket(clientSocket, () => phase);
    void (async () => {
      const match = /^\[?([^\]]+)\]?:([0-9]+)$/u.exec(request.url ?? "");
      if (!match) throw new Error("AGENT_SANDBOX_EGRESS_CONNECT_INVALID: Invalid CONNECT target");
      const port = parsePort(match[2]!);
      phase = "resolution";
      const target = await resolveTarget(match[1]!, port);
      if (clientUnavailable()) return;
      phase = "connect";
      const upstream = connectWithDeadline(() => connect({
        family: target.family,
        host: target.address,
        port: target.port,
      }), CONNECT_TIMEOUT_MS);
      bindTunnelLifecycle(clientSocket, upstream);
      if (clientUnavailable()) {
        upstream.destroy();
        return;
      }
      upstream.once("close", () => meter.close({ host: target.hostname, kind: "connect", port }));
      upstream.once("connect", () => {
        phase = "tunnel";
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        // Counted as it flows, so one long tunnel cannot outlast the day's budget.
        const meterUp = meterChunks(meter, "up", [upstream, clientSocket]);
        upstream.on("data", meterChunks(meter, "down", [upstream, clientSocket]));
        clientSocket.on("data", meterUp);
        if (initialData.byteLength > 0) {
          meterUp(initialData);
          upstream.write(initialData);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.once("error", (error) => {
        console.error("Sandbox CONNECT failed", {
          error,
          hostname: target.hostname,
          phase,
          port,
        });
        rejectSocket(clientSocket, 502, "Bad Gateway");
      });
    })().catch((error: unknown) => {
      console.error("Sandbox CONNECT rejected", { error, phase, target: request.url });
      rejectSocket(clientSocket, 403, "Forbidden");
    });
  });

  return server;
}
