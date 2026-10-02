import {
  McpServer,
  createMcpHandler,
} from "#compiled/@modelcontextprotocol/server/index.js";
const MCP_PROTOCOL_VERSION = `2026-07-28`,
  MCP_LEGACY_PROTOCOL_VERSION = `2025-11-25`;
function defineMcpTool(e) {
  return {
    name: e.definition.name,
    register(t, n) {
      t.registerTool(
        e.definition.name,
        {
          ...(e.definition.annotations === void 0
            ? {}
            : { annotations: e.definition.annotations }),
          ...(e.definition.description === void 0
            ? {}
            : { description: e.definition.description }),
          inputSchema: e.definition.inputSchema,
          ...(e.definition.outputSchema === void 0
            ? {}
            : { outputSchema: e.definition.outputSchema }),
        },
        async (t, r) => await callTool(e.call, t, r.mcpReq.signal, n),
      );
    },
  };
}
function createMcpStreamableHttpServer(e) {
  let n = new Map(e.tools.map((e) => [e.name, e]));
  if (n.size !== e.tools.length) throw Error(`MCP tool names must be unique.`);
  return async (r) => {
    let i = await e.authenticate(r);
    if (i instanceof Response) return i;
    let a = await preflightModernRequest(r);
    return a.response === void 0
      ? await createMcpHandler(() => createServer(e, n, i), {
          legacy: `stateless`,
        }).fetch(
          r,
          a.parsedBody === void 0 ? void 0 : { parsedBody: a.parsedBody },
        )
      : a.response;
  };
}
async function preflightModernRequest(e) {
  if (
    e.method.toUpperCase() !== `POST` ||
    e.headers.has(`mcp-protocol-version`)
  )
    return {};
  let t = await inspectRequestBody(e);
  if (t.tooLarge) return { response: requestBodyTooLargeResponse() };
  if (t.invalidJson) return { response: invalidJsonResponse() };
  let n = t.value;
  if (n === void 0) return {};
  if (!claimsCurrentProtocolVersion(n)) return { parsedBody: n };
  let r = await probeEarlierValidationFailure(e, n);
  return r === void 0
    ? { parsedBody: n, response: headerMismatchResponse(n) }
    : { parsedBody: n, response: r };
}
async function inspectRequestBody(e) {
  let t = e.body;
  if (t === null) return { tooLarge: !1 };
  let n = t.getReader(),
    r = [],
    i = 0;
  try {
    for (;;) {
      let e = await n.read();
      if (e.done) break;
      if (((i += e.value.byteLength), i > 4194304))
        return (await n.cancel(), { tooLarge: !0 });
      r.push(e.value);
    }
    let e = new Uint8Array(i),
      t = 0;
    for (let n of r) (e.set(n, t), (t += n.byteLength));
    return { tooLarge: !1, value: JSON.parse(new TextDecoder().decode(e)) };
  } catch {
    return { invalidJson: !0, tooLarge: !1 };
  }
}
function invalidJsonResponse() {
  return Response.json(
    {
      error: { code: -32700, message: `Parse error` },
      id: null,
      jsonrpc: `2.0`,
    },
    { status: 400 },
  );
}
function requestBodyTooLargeResponse() {
  return Response.json(
    {
      error: { code: -32e3, message: `Request body too large` },
      id: null,
      jsonrpc: `2.0`,
    },
    { status: 413, statusText: `Request Entity Too Large` },
  );
}
function claimsCurrentProtocolVersion(e) {
  return (
    isPlainRecord(e) &&
    isPlainRecord(e.params) &&
    isPlainRecord(e.params._meta) &&
    e.params._meta[`io.modelcontextprotocol/protocolVersion`] === `2026-07-28`
  );
}
function isPlainRecord(e) {
  return typeof e == `object` && !!e && !Array.isArray(e);
}
async function probeEarlierValidationFailure(r, i) {
  let a = new Headers(r.headers);
  a.set(`mcp-protocol-version`, MCP_PROTOCOL_VERSION);
  let o = new Request(r.url, {
      body: JSON.stringify(i),
      headers: a,
      method: r.method,
    }),
    s = createMcpHandler(
      () => new McpServer({ name: `eve-mcp-preflight`, version: `0` }),
      { legacy: `reject` },
    );
  try {
    let e = await s.fetch(o, { parsedBody: i });
    if (e.status === 406 || e.status === 415) return e;
    if (e.status === 400) {
      let t = await e
        .clone()
        .json()
        .catch(() => void 0);
      if (
        t?.error?.code === -32700 ||
        t?.error?.code === -32600 ||
        t?.error?.code === -32602 ||
        t?.error?.code === -32022
      )
        return e;
    }
    await e.body?.cancel();
    return;
  } finally {
    await s.close().catch(() => {});
  }
}
function headerMismatchResponse(e) {
  let t = `the body carries a modern MCP envelope but the required MCP-Protocol-Version header is absent`;
  return Response.json(
    {
      error: {
        code: -32020,
        data: { mismatch: { body: t, header: `(missing)` } },
        message: `Bad Request: the request headers and body disagree: ${t}`,
      },
      id: readJsonRpcRequestId(e),
      jsonrpc: `2.0`,
    },
    { status: 400 },
  );
}
function readJsonRpcRequestId(e) {
  if (typeof e != `object` || !e || Array.isArray(e)) return null;
  let t = Reflect.get(e, `id`);
  return typeof t == `string` || typeof t == `number` ? t : null;
}
function createServer(t, n, r) {
  let i = new McpServer(
    { name: t.name, version: t.version },
    { capabilities: { tools: { listChanged: !1 } } },
  );
  for (let e of n.values()) e.register(i, r);
  return i;
}
async function callTool(e, t, n, r) {
  try {
    return await e(t, { auth: r, signal: n });
  } catch (e) {
    return toolError(e instanceof Error ? e.message : `Tool call failed.`);
  }
}
function toolError(e) {
  return { content: [{ type: `text`, text: e }], isError: !0 };
}
export {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  createMcpStreamableHttpServer,
  defineMcpTool,
};
