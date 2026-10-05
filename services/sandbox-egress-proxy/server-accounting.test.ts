/**
 * The proxy's forwarding and byte budget against local servers (Codex review, 5 October 2026).
 *
 * Constructs covered:
 * - An HTTP request body reaches the destination whole, though the count of it starts before
 *   the destination is resolved.
 * - A CONNECT tunnel is closed once its bytes cross the day's budget, not only counted at the end.
 * - An upgrade request whose target the URL parser rejects is refused, and the proxy keeps serving.
 */
import { once } from "node:events";
import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createEgressLedger } from "./egress-ledger.js";
import { createSandboxEgressProxy } from "./server.js";

const servers: Array<{ close: () => unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen<T extends Server | ReturnType<typeof createHttpServer>>(server: T): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function proxyTo(destinationPort: number, dailyBytes = 1_000_000): Promise<number> {
  return await listen(createSandboxEgressProxy({
    ledger: createEgressLedger({ dailyBytes, log: () => undefined }),
    resolveTarget: async (hostname, port) => {
      // The DNS lookup takes a moment, as a real one does.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { address: "127.0.0.1", family: 4, hostname, port: port === 80 ? destinationPort : port };
    },
  }));
}

describe("sandbox egress proxy accounting", () => {
  it("forwards an HTTP request body whole", async () => {
    const destination = createHttpServer((incoming, outgoing) => {
      let body = "";
      incoming.on("data", (chunk: Buffer) => { body += chunk.toString("latin1"); });
      incoming.on("end", () => outgoing.end(body));
    });
    const proxy = await proxyTo(await listen(destination));

    const sent = "x".repeat(5_000);
    const req = request({ host: "127.0.0.1", method: "POST", path: "http://example.com/echo", port: proxy, headers: { "content-length": sent.length } });
    req.end(sent);
    const [response] = await once(req, "response") as [import("node:http").IncomingMessage];
    let echoed = "";
    for await (const chunk of response) echoed += chunk;

    expect(response.statusCode).toBe(200);
    expect(echoed).toBe(sent);
  });

  it("closes a CONNECT tunnel that crosses the day's budget and refuses the next one", async () => {
    const destination = createTcpServer((socket) => {
      socket.on("error", () => undefined);
      socket.write(Buffer.alloc(4_000, 1));
    });
    const destinationPort = await listen(destination);
    const proxy = await listen(createSandboxEgressProxy({
      ledger: createEgressLedger({ dailyBytes: 1_000, log: () => undefined }),
      resolveTarget: async (hostname) => ({ address: "127.0.0.1", family: 4, hostname, port: destinationPort }),
    }));

    const tunnel = connect(proxy, "127.0.0.1");
    tunnel.on("error", () => undefined);
    tunnel.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    let received = 0;
    tunnel.on("data", (chunk: Buffer) => { received += chunk.byteLength; });
    await once(tunnel, "close");
    // The 200 line, then at most the chunk that crossed the budget.
    expect(received).toBeLessThan(4_100);

    const next = connect(proxy, "127.0.0.1");
    next.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    const [answer] = await once(next, "data") as [Buffer];
    expect(answer.toString("latin1")).toMatch(/^HTTP\/1\.1 429 /u);
    next.destroy();
  });

  it("refuses an upgrade whose target does not parse and keeps serving", async () => {
    const proxy = await proxyTo(1);
    const socket = connect(proxy, "127.0.0.1");
    socket.write("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    const [answer] = await once(socket, "data") as [Buffer];
    expect(answer.toString("latin1")).toMatch(/^HTTP\/1\.1 400 /u);
    socket.destroy();

    const again = connect(proxy, "127.0.0.1");
    again.write("GET /elsewhere HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    const [next] = await once(again, "data") as [Buffer];
    expect(next.toString("latin1")).toMatch(/^HTTP\/1\.1 404 /u);
    again.destroy();
  });
});
