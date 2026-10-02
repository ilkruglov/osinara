import { createLogger, logError } from "#internal/logging.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import { hasInternalRefScheme } from "#internal/attachments/url-refs.js";
import {
  EVE_INFO_ROUTE_PATH,
  EVE_SESSION_CANCEL_ROUTE_PATTERN,
  EVE_SESSION_CLEAR_ROUTE_PATTERN,
  EVE_SESSION_COMPACT_ROUTE_PATTERN,
  EVE_SESSION_RESET_ROUTE_PATTERN,
  EVE_SESSION_ROUTE_PATH,
  EVE_SESSION_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
  EVE_SUBAGENT_STREAM_ROUTE_PATTERN,
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
} from "#protocol/routes.js";
import {
  EVE_MESSAGE_STREAM_CONTENT_TYPE,
  EVE_MESSAGE_STREAM_FORMAT,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";
import { isInputResponse } from "#runtime/input/types.js";
import { parseJsonObject } from "#shared/json.js";
import { GET, POST, defineChannel } from "#public/definitions/channel.js";
import "ai";
import { parseSessionCallback } from "#channel/session-callback.js";
import { parseTraceparent } from "#protocol/traceparent.js";
import { routeAuth } from "#public/channels/auth.js";
import {
  readAgentInfoRouteResponse,
  readRemoteAgentStreamHeadersResolver,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { resolveForwardedPrincipal } from "#channel/forwarded-principal.js";
import {
  collectUploadPolicyViolations,
  formatUploadPolicyViolation,
  mergeUploadPolicy,
} from "#public/channels/upload-policy.js";
const log = createLogger(`eve.channel`);
function defaultEveAuth(e) {
  return e.eve.caller;
}
function eveChannel(e) {
  let r = mergeUploadPolicy(e.uploadPolicy);
  return defineChannel({
    cors: normalizeEveCors(e.cors),
    turnPolicy: e.turnPolicy,
    routes: [
      GET(EVE_INFO_ROUTE_PATH, async (t, n) => {
        let r = await routeAuth(t, e.auth);
        if (r instanceof Response) return r;
        let i = readAgentInfoRouteResponse(n);
        return i === void 0
          ? Response.json(
              {
                error: `Agent info route requires internal channel dispatch context.`,
                ok: !1,
              },
              { status: 500 },
            )
          : await i();
      }),
      POST(EVE_SESSION_ROUTE_PATH, async (i, a) => {
        let o = await routeAuth(i, e.auth);
        if (o instanceof Response) return o;
        let s = await parseJsonRequest(i);
        if (s instanceof Response) return s;
        let c = rejectSessionContinuationToken(s);
        if (c !== null) return c;
        let l = await resolveForwardedPrincipal({
          trustedForwarders: e.trustedForwarders,
          forwarder: o,
          payload: s,
        });
        if (l instanceof Response) return l;
        let u = parseCreateBody(s);
        if (u instanceof Response) return u;
        let d =
            u.callback === void 0
              ? void 0
              : parseTraceparent(i.headers.get(`traceparent`)),
          f = checkUploadPolicy(u, r);
        if (f !== null) return f;
        if (u.operationId !== void 0 && l.auth.principalType === `anonymous`)
          return Response.json(
            {
              error: `operationId requires an authenticated principal.`,
              ok: !1,
            },
            { status: 400 },
          );
        let p =
          u.operationId === void 0
            ? void 0
            : await deriveOperationContinuationToken({
                auth: l.auth,
                operationId: u.operationId,
              });
        if (p !== void 0) {
          let e = await a.resolveSession(p);
          if (e !== void 0)
            return Response.json(
              { ok: !0, sessionId: e.id, status: `accepted` },
              {
                headers: {
                  "cache-control": `no-store`,
                  [EVE_SESSION_ID_HEADER]: e.id,
                },
                status: 202,
              },
            );
        }
        let m = await resolveOnMessage({
          auth: l.auth,
          config: e,
          message: u.message,
          request: i,
        });
        if (m instanceof Response) return m;
        let h = readRouteSessionCreator(a);
        if (h === void 0)
          return Response.json(
            {
              error: `Session creation requires internal channel dispatch context.`,
              ok: !1,
            },
            { status: 500 },
          );
        let g;
        try {
          g = await h({
            auth: m.auth,
            capabilities:
              u.capabilities ??
              (u.mode === `task` ? void 0 : { requestInput: !0 }),
            callback: u.callback,
            continuationToken: p,
            initiatorAuth: l.accepted ? l.initiatorAuth : void 0,
            input: {
              message: u.message,
              context: mergeContext(u.context, m.context),
              outputSchema: u.outputSchema,
            },
            mode: u.mode ?? `conversation`,
            parentTraceContext: d,
            title: m.title,
          });
        } catch (e) {
          if (p !== void 0 && isRuntimeSessionOwnershipConflictError(e))
            return Response.json(
              { ok: !0, sessionId: e.ownerSessionId, status: `accepted` },
              {
                headers: {
                  "cache-control": `no-store`,
                  [EVE_SESSION_ID_HEADER]: e.ownerSessionId,
                },
                status: 202,
              },
            );
          let r = logError(log, `session-create request failed`, e);
          return Response.json(
            { error: `Failed to create the session.`, errorId: r, ok: !1 },
            { status: 500 },
          );
        }
        return Response.json(
          { ok: !0, sessionId: g.sessionId, status: `accepted` },
          {
            headers: {
              "cache-control": `no-store`,
              [EVE_SESSION_ID_HEADER]: g.sessionId,
            },
            status: 202,
          },
        );
      }),
      POST(
        EVE_SESSION_ROUTE_PATTERN,
        async (n, { attachSession: i, params: a }) => {
          let o = await routeAuth(n, e.auth);
          if (o instanceof Response) return o;
          let s = requireSessionId(a);
          if (s instanceof Response) return s;
          let c = await parseJsonRequest(n);
          if (c instanceof Response) return c;
          let l = parseSessionMessageBody(c);
          if (l instanceof Response) return l;
          let u = checkUploadPolicy(l, r);
          if (u !== null) return u;
          let d = l.context,
            f = o;
          if (l.message !== void 0) {
            let t = await resolveOnMessage({
              auth: o,
              config: e,
              message: l.message,
              request: n,
              sessionId: s,
            });
            if (t instanceof Response) return t;
            ((d = mergeContext(l.context, t.context)), (f = t.auth));
          }
          let p;
          try {
            let e = i(s),
              t = {
                auth: f,
                callback: l.callback,
                context: d,
                outputSchema: l.outputSchema,
                turnPolicy: l.turnPolicy,
              };
            p =
              l.inputResponses === void 0
                ? await e.send(l.message, t)
                : await e.respond(l.inputResponses, t);
          } catch (e) {
            let n = logError(log, `session-message request failed`, e, {
              sessionId: s,
            });
            return Response.json(
              {
                error: `Failed to send the session message.`,
                errorId: n,
                ok: !1,
              },
              { status: 500 },
            );
          }
          return p.status === `session_not_active`
            ? Response.json(
                {
                  code: `session_not_active`,
                  error: `The session is no longer active.`,
                  ok: !1,
                },
                { headers: { "cache-control": `no-store` }, status: 409 },
              )
            : Response.json(
                { ok: !0, sessionId: p.sessionId, status: `accepted` },
                {
                  headers: {
                    "cache-control": `no-store`,
                    [EVE_SESSION_ID_HEADER]: p.sessionId,
                  },
                  status: 202,
                },
              );
        },
      ),
      POST(
        EVE_SESSION_CANCEL_ROUTE_PATTERN,
        async (n, { attachSession: r, params: i }) => {
          let a = await routeAuth(n, e.auth);
          if (a instanceof Response) return a;
          let o = requireSessionId(i);
          if (o instanceof Response) return o;
          let s = await parseCancelTurnBody(n);
          if (s instanceof Response) return s;
          let c;
          try {
            c = await r(o).cancel({ taskId: s.taskId, turnId: s.turnId });
          } catch (e) {
            let n = logError(log, `cancel-turn request failed`, e, {
              sessionId: o,
            });
            return Response.json(
              { error: `Failed to cancel the turn.`, errorId: n, ok: !1 },
              { status: 500 },
            );
          }
          return Response.json(
            c.status === `accepted`
              ? { ok: !0, sessionId: c.sessionId, status: `accepted` }
              : { ok: !0, status: `no_active_turn` },
            {
              headers: { "cache-control": `no-store` },
              status: c.status === `accepted` ? 202 : 200,
            },
          );
        },
      ),
      POST(
        EVE_SESSION_COMPACT_ROUTE_PATTERN,
        async (n, { attachSession: r, params: i }) => {
          let a = await routeAuth(n, e.auth);
          if (a instanceof Response) return a;
          let o = requireSessionId(i);
          if (o instanceof Response) return o;
          let s = await parseSessionControlBody(n);
          if (s instanceof Response) return s;
          let c;
          try {
            c = await r(o).compact();
          } catch (e) {
            let n = logError(log, `session-compaction request failed`, e, {
              sessionId: o,
            });
            return Response.json(
              { error: `Failed to compact the session.`, errorId: n, ok: !1 },
              { status: 500 },
            );
          }
          return Response.json(
            c.status === `accepted`
              ? { ok: !0, sessionId: c.sessionId, status: `accepted` }
              : { ok: !0, status: `no_active_session` },
            {
              headers: { "cache-control": `no-store` },
              status: c.status === `accepted` ? 202 : 200,
            },
          );
        },
      ),
      POST(
        EVE_SESSION_CLEAR_ROUTE_PATTERN,
        async (n, { attachSession: r, params: i }) => {
          let a = await routeAuth(n, e.auth);
          if (a instanceof Response) return a;
          let o = requireSessionId(i);
          if (o instanceof Response) return o;
          let s = await parseSessionControlBody(n);
          if (s instanceof Response) return s;
          let c;
          try {
            c = await r(o).clear();
          } catch (e) {
            let n = logError(log, `session-clear request failed`, e, {
              sessionId: o,
            });
            return Response.json(
              {
                error: `Failed to clear the session context.`,
                errorId: n,
                ok: !1,
              },
              { status: 500 },
            );
          }
          return Response.json(
            c.status === `accepted`
              ? { ok: !0, sessionId: c.sessionId, status: `accepted` }
              : { ok: !0, status: `no_active_session` },
            {
              headers: { "cache-control": `no-store` },
              status: c.status === `accepted` ? 202 : 200,
            },
          );
        },
      ),
      POST(
        EVE_SESSION_RESET_ROUTE_PATTERN,
        async (n, { attachSession: r, params: i }) => {
          let a = await routeAuth(n, e.auth);
          if (a instanceof Response) return a;
          let o = requireSessionId(i);
          if (o instanceof Response) return o;
          let s = await parseResetBody(n);
          if (s instanceof Response) return s;
          let c;
          try {
            c = await r(o).reset({ reason: s.reason });
          } catch (e) {
            let n = logError(log, `session-reset request failed`, e, {
              sessionId: o,
            });
            return Response.json(
              { error: `Failed to reset the session.`, errorId: n, ok: !1 },
              { status: 500 },
            );
          }
          return Response.json(
            c.status === `reset`
              ? {
                  ok: !0,
                  previousSessionId: c.previousSessionId,
                  status: `reset`,
                }
              : { ok: !0, status: `no_active_session` },
            { headers: { "cache-control": `no-store` } },
          );
        },
      ),
      GET(
        EVE_SESSION_STREAM_ROUTE_PATTERN,
        async (t, { attachSession: n, params: r }) => {
          let i = await routeAuth(t, e.auth);
          if (i instanceof Response) return i;
          let a = requireSessionId(r);
          return a instanceof Response
            ? a
            : await createSessionStreamResponse(t, n(a));
        },
      ),
      GET(EVE_SUBAGENT_STREAM_ROUTE_PATTERN, async (t, n) => {
        let r = await routeAuth(t, e.auth);
        if (r instanceof Response) return r;
        let i = n.params.parentSessionId,
          a = n.params.callId,
          o = n.params.childSessionId;
        if (!i || !a || !o)
          return Response.json(
            { error: `Missing subagent stream coordinates.`, ok: !1 },
            { status: 400 },
          );
        let s = parseStartIndex(t);
        if (s instanceof Response) return s;
        let c = parseIncludeTailIndex(t),
          l = createEveSubagentStreamRoutePath({
            callId: a,
            childSessionId: o,
            parentSessionId: i,
          }),
          u;
        try {
          let e = await findRemoteSubagentBinding({
            callId: a,
            childSessionId: o,
            childStreamPath: l,
            parentSessionId: i,
            parent: n.attachSession(i),
          });
          if (e === void 0) throw Error(`Remote subagent binding not found.`);
          u = e;
        } catch {
          return Response.json(
            { error: `Subagent stream not found.`, ok: !1 },
            { status: 404 },
          );
        }
        let d = readRemoteAgentStreamHeadersResolver(n);
        if (d === void 0)
          return Response.json(
            {
              error: `Subagent stream proxy requires internal channel dispatch context.`,
              ok: !1,
            },
            { status: 500 },
          );
        let f;
        try {
          f = await d({
            name: u.data.toolName,
            resolverId: u.data.remote.resolverId,
            url: u.data.remote.url,
          });
        } catch {
          return Response.json(
            { error: `Subagent stream not found.`, ok: !1 },
            { status: 404 },
          );
        }
        let h = new URL(
          createEveSessionStreamRoutePath(o).replace(/^\/+/, ``),
          `${u.data.remote.url.replace(/\/+$/, ``)}/`,
        );
        (s !== void 0 && h.searchParams.set(`startIndex`, String(s)),
          c && h.searchParams.set(`includeTailIndex`, `1`));
        let g = await fetch(h, {
            cache: `no-store`,
            headers: f,
            redirect: `manual`,
            signal: t.signal,
          }),
          _ = new Headers();
        for (let e of [
          `cache-control`,
          `content-type`,
          `x-accel-buffering`,
          EVE_SESSION_ID_HEADER,
          EVE_STREAM_FORMAT_HEADER,
          EVE_STREAM_TAIL_INDEX_HEADER,
          EVE_STREAM_VERSION_HEADER,
        ]) {
          let t = g.headers.get(e);
          t !== null && _.set(e, t);
        }
        return new Response(g.body, {
          headers: _,
          status: g.status,
          statusText: g.statusText,
        });
      }),
    ],
    events: e.events,
  });
}
async function findRemoteSubagentBinding(e) {
  let t = await e.parent.getStreamTailIndex();
  if (t < 0) return;
  let n = (await e.parent.getEventStream({ startIndex: 0 })).getReader(),
    r;
  try {
    for (let i = 0; i <= t; i += 1) {
      let t = await n.read();
      if (t.done) break;
      let i = t.value;
      i.type === `subagent.called` &&
        i.data.sessionId === e.parentSessionId &&
        i.data.callId === e.callId &&
        i.data.childSessionId === e.childSessionId &&
        i.data.childStreamPath === e.childStreamPath &&
        i.data.remote !== void 0 &&
        (r = i);
    }
  } finally {
    await n.cancel().catch(() => {});
  }
  return r;
}
function normalizeEveCors(e) {
  if (e === void 0 || e === !1) return !1;
  if (e === !0) return !0;
  let t = {};
  return (
    e.origin !== void 0 && (t.origin = normalizeEveCorsOrigin(e.origin)),
    e.methods !== void 0 && (t.methods = e.methods),
    e.allowedHeaders !== void 0 && (t.allowHeaders = e.allowedHeaders),
    e.exposedHeaders !== void 0 && (t.exposeHeaders = e.exposedHeaders),
    e.credentials !== void 0 && (t.credentials = e.credentials),
    e.maxAge !== void 0 && (t.maxAge = e.maxAge),
    e.preflightStatus !== void 0 &&
      (t.preflight = { statusCode: e.preflightStatus }),
    t
  );
}
function normalizeEveCorsOrigin(e) {
  return e === `*` || e === `null` ? e : typeof e == `string` ? [e] : e;
}
async function resolveOnMessage(e) {
  let n = e.config.onMessage ?? defaultOnMessage,
    r;
  try {
    if (
      ((r = await n(
        {
          eve:
            e.sessionId === void 0
              ? { caller: e.auth, request: e.request }
              : { caller: e.auth, request: e.request, sessionId: e.sessionId },
        },
        e.message,
      )),
      r == null)
    )
      throw TypeError(`eveChannel onMessage must return an auth result.`);
  } catch (n) {
    let r = logError(log, `onMessage handler failed`, n, {
      sessionId: e.sessionId,
    });
    return Response.json(
      { error: `onMessage handler failed.`, errorId: r, ok: !1 },
      { status: 500 },
    );
  }
  return { auth: r.auth, context: r.context, title: r.title };
}
function defaultOnMessage(e) {
  return { auth: defaultEveAuth(e) };
}
async function deriveOperationContinuationToken(e) {
  let t = JSON.stringify([
      `eve:create-session:v1`,
      e.auth.authenticator,
      e.auth.issuer ?? null,
      e.auth.principalType,
      e.auth.principalId,
      e.operationId,
    ]),
    n = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(t));
  return `eve:op:${Array.from(new Uint8Array(n), (e) =>
    e.toString(16).padStart(2, `0`),
  )
    .join(``)
    .slice(0, 32)}`;
}
function parseCreateBody(e) {
  if (e.inputResponses !== void 0)
    return Response.json(
      {
        error: `'inputResponses' is only accepted for an existing session.`,
        ok: !1,
      },
      { status: 400 },
    );
  let t = parseMessageField(e.message);
  if (t instanceof Response) return t;
  let n = parseClientContextField(e.clientContext);
  if (n instanceof Response) return n;
  let r = parseCallbackField(e.callback);
  if (r instanceof Response) return r;
  let i = parseCapabilitiesField(e.capabilities);
  if (i instanceof Response) return i;
  let a = parseModeField(e.mode);
  if (a instanceof Response) return a;
  let o = parseOutputSchemaField(e.outputSchema);
  if (o instanceof Response) return o;
  if (t === void 0)
    return Response.json(
      { error: `Missing or empty 'message' field.`, ok: !1 },
      { status: 400 },
    );
  let s = e.operationId;
  if (s !== void 0 && (typeof s != `string` || !s))
    return Response.json(
      { error: `Expected 'operationId' to be a non-empty string.`, ok: !1 },
      { status: 400 },
    );
  let c = {
    callback: r,
    capabilities: i,
    message: t,
    mode: a,
    context: n,
    outputSchema: o,
  };
  return (typeof s == `string` && (c.operationId = s), c);
}
function parseSessionMessageBody(e) {
  let t = rejectSessionContinuationToken(e);
  if (t !== null) return t;
  if (e.forwardedPrincipal !== void 0)
    return Response.json(
      {
        error: `A forwarded principal is only accepted on session creation.`,
        ok: !1,
      },
      { status: 400 },
    );
  let n = parseMessageField(e.message);
  if (n instanceof Response) return n;
  let r = parseCallbackField(e.callback);
  if (r instanceof Response) return r;
  let i = parseInputResponses(e.inputResponses);
  if (i instanceof Response) return i;
  let a = parseClientContextField(e.clientContext);
  if (a instanceof Response) return a;
  let o = parseOutputSchemaField(e.outputSchema);
  if (o instanceof Response) return o;
  let s = parseTurnPolicyField(e.turnPolicy);
  return s instanceof Response
    ? s
    : n === void 0 && i === void 0
      ? Response.json(
          {
            error: `Expected a non-empty 'message' or a non-empty 'inputResponses' array.`,
            ok: !1,
          },
          { status: 400 },
        )
      : n !== void 0 && i !== void 0
        ? Response.json(
            {
              error: `'message' and 'inputResponses' are mutually exclusive.`,
              ok: !1,
            },
            { status: 400 },
          )
        : {
            callback: r,
            message: n,
            inputResponses: i,
            context: a,
            outputSchema: o,
            turnPolicy: s,
          };
}
async function parseCancelTurnBody(e) {
  let t = await parseOptionalJsonRequest(e);
  if (t instanceof Response) return t;
  let n = rejectSessionContinuationToken(t);
  if (n !== null) return n;
  let r = t.turnId,
    i = t.taskId;
  if (r !== void 0 && (typeof r != `string` || r.length === 0))
    return Response.json(
      { error: `Expected 'turnId' to be a non-empty string.`, ok: !1 },
      { status: 400 },
    );
  if (i !== void 0 && (typeof i != `string` || i.length === 0))
    return Response.json(
      { error: `Expected 'taskId' to be a non-empty string.`, ok: !1 },
      { status: 400 },
    );
  let a = {};
  return (
    typeof i == `string` && (a.taskId = i),
    typeof r == `string` && (a.turnId = r),
    a
  );
}
async function parseJsonRequest(e) {
  let t;
  try {
    t = await e.json();
  } catch {
    return Response.json(
      { error: `Invalid JSON body.`, ok: !1 },
      { status: 400 },
    );
  }
  return typeof t != `object` || !t || Array.isArray(t)
    ? Response.json(
        { error: `Expected a JSON object.`, ok: !1 },
        { status: 400 },
      )
    : t;
}
async function parseResetBody(e) {
  let t = await parseOptionalJsonRequest(e);
  if (t instanceof Response) return t;
  let n = rejectSessionContinuationToken(t);
  if (n !== null) return n;
  let r = t.reason;
  return r !== void 0 && (typeof r != `string` || r.length === 0)
    ? Response.json(
        { error: `Expected 'reason' to be a non-empty string.`, ok: !1 },
        { status: 400 },
      )
    : r === void 0
      ? {}
      : { reason: r };
}
async function parseSessionControlBody(e) {
  let t = await parseOptionalJsonRequest(e);
  return t instanceof Response ? t : (rejectSessionContinuationToken(t) ?? t);
}
async function parseOptionalJsonRequest(e) {
  let t;
  try {
    t = await e.text();
  } catch {
    return Response.json(
      { error: `Unreadable request body.`, ok: !1 },
      { status: 400 },
    );
  }
  if (t.trim().length === 0) return {};
  let n;
  try {
    n = JSON.parse(t);
  } catch {
    return Response.json(
      { error: `Invalid JSON body.`, ok: !1 },
      { status: 400 },
    );
  }
  return typeof n != `object` || !n || Array.isArray(n)
    ? Response.json(
        { error: `Expected a JSON object.`, ok: !1 },
        { status: 400 },
      )
    : n;
}
function rejectSessionContinuationToken(e) {
  return `continuationToken` in e
    ? Response.json(
        {
          error: `Session-ID routes do not accept 'continuationToken'.`,
          ok: !1,
        },
        { status: 400 },
      )
    : null;
}
function requireSessionId(e) {
  return (
    e.sessionId ||
    Response.json({ error: `Missing session id.`, ok: !1 }, { status: 400 })
  );
}
async function createSessionStreamResponse(e, t) {
  let n = parseStartIndex(e);
  if (n instanceof Response) return n;
  let r = parseIncludeTailIndex(e);
  try {
    let e = r ? await t.getStreamTailIndex() : void 0,
      i = await t.getEventStream({ startIndex: n }),
      a = new Headers({
        "cache-control": `no-store, no-transform`,
        "content-type": EVE_MESSAGE_STREAM_CONTENT_TYPE,
        "x-accel-buffering": `no`,
        [EVE_SESSION_ID_HEADER]: t.id,
        [EVE_STREAM_FORMAT_HEADER]: EVE_MESSAGE_STREAM_FORMAT,
        [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
      });
    return (
      e !== void 0 && a.set(EVE_STREAM_TAIL_INDEX_HEADER, String(e)),
      new Response(serializeAsNdjson(i), { headers: a })
    );
  } catch {
    return Response.json(
      { error: `Session not found.`, ok: !1 },
      { status: 404 },
    );
  }
}
function parseOutputSchemaField(e) {
  if (e !== void 0)
    try {
      return parseJsonObject(e);
    } catch {
      return Response.json(
        {
          error: `Expected 'outputSchema' to be a JSON-serializable object.`,
          ok: !1,
        },
        { status: 400 },
      );
    }
}
function parseCallbackField(e) {
  if (e === void 0) return;
  let t = parseSessionCallback(e);
  return t.ok
    ? t.callback
    : Response.json({ error: t.message, ok: !1 }, { status: 400 });
}
function parseCapabilitiesField(e) {
  if (e === void 0) return;
  if (typeof e != `object` || !e || Array.isArray(e))
    return Response.json(
      { error: `Expected 'capabilities' to be an object.`, ok: !1 },
      { status: 400 },
    );
  let t = Object.keys(e),
    n = Reflect.get(e, `requestInput`);
  return t.some((e) => e !== `requestInput`) ||
    (n !== void 0 && typeof n != `boolean`)
    ? Response.json(
        {
          error: `Expected 'capabilities.requestInput' to be a boolean when provided.`,
          ok: !1,
        },
        { status: 400 },
      )
    : n === void 0
      ? {}
      : { requestInput: n };
}
function parseModeField(e) {
  if (e !== void 0)
    return e === `conversation` || e === `task`
      ? e
      : Response.json(
          {
            error: `Expected 'mode' to be either 'conversation' or 'task'.`,
            ok: !1,
          },
          { status: 400 },
        );
}
function parseTurnPolicyField(e) {
  if (e !== void 0)
    return e === `queue` || e === `steer`
      ? e
      : Response.json(
          {
            error: `Expected 'turnPolicy' to be either 'queue' or 'steer'.`,
            ok: !1,
          },
          { status: 400 },
        );
}
function parseMessageField(e) {
  if (e === void 0) return;
  if (typeof e == `string`) return e.length > 0 ? e : void 0;
  if (!Array.isArray(e))
    return Response.json(
      {
        error: `Expected 'message' to be a string or an array of text/file parts.`,
        ok: !1,
      },
      { status: 400 },
    );
  if (e.length === 0) return;
  let t = [];
  for (let n of e) {
    let e = parseMessagePart(n);
    if (e instanceof Response) return e;
    t.push(e);
  }
  return t;
}
function parseMessagePart(e) {
  if (typeof e != `object` || !e)
    return Response.json(
      { error: `Expected each message part to be an object.`, ok: !1 },
      { status: 400 },
    );
  let t = e;
  if (t.type === `text`)
    return typeof t.text != `string` || t.text.length === 0
      ? Response.json(
          { error: `Text parts require a non-empty 'text' string.`, ok: !1 },
          { status: 400 },
        )
      : { type: `text`, text: t.text };
  if (t.type === `file`) {
    if (typeof t.mediaType != `string` || t.mediaType.length === 0)
      return Response.json(
        { error: `File parts require a non-empty 'mediaType' string.`, ok: !1 },
        { status: 400 },
      );
    if (typeof t.data != `string`)
      return Response.json(
        {
          error: `File parts require a 'data' string (base64, data URL, or URL).`,
          ok: !1,
        },
        { status: 400 },
      );
    if (hasInternalRefScheme(t.data))
      return Response.json(
        {
          error: `File part 'data' must not use a framework-internal ref scheme.`,
          ok: !1,
        },
        { status: 400 },
      );
    let e = { type: `file`, mediaType: t.mediaType, data: t.data };
    return (
      typeof t.filename == `string` &&
        t.filename.length > 0 &&
        (e.filename = t.filename),
      e
    );
  }
  return Response.json(
    {
      error: `Unsupported message part type "${String(t.type)}". Use 'text' or 'file'.`,
      ok: !1,
    },
    { status: 400 },
  );
}
function checkUploadPolicy(e, t) {
  if (!e.message) return null;
  let n = collectUploadPolicyViolations(e.message, t);
  if (n.length === 0) return null;
  let [r] = n;
  if (!r) return null;
  let i = r.kind === `too-large` ? 413 : 415;
  return Response.json(
    {
      error: formatUploadPolicyViolation(r),
      ok: !1,
      violations: n.map((e) =>
        e.kind === `too-large`
          ? {
              byteLength: e.byteLength,
              filename: e.filename,
              kind: e.kind,
              limit: e.limit,
              mediaType: e.mediaType,
            }
          : {
              allowedMediaTypes: e.allowedMediaTypes,
              filename: e.filename,
              kind: e.kind,
              mediaType: e.mediaType,
            },
      ),
    },
    { status: i },
  );
}
function parseInputResponses(e) {
  if (e === void 0) return;
  if (!Array.isArray(e) || e.length === 0)
    return Response.json(
      { error: `Expected 'inputResponses' to be a non-empty array.`, ok: !1 },
      { status: 400 },
    );
  let t = e.filter(isInputResponse);
  return t.length === e.length
    ? t
    : Response.json(
        {
          error: `Expected every 'inputResponses' entry to match the HITL response schema.`,
          ok: !1,
        },
        { status: 400 },
      );
}
function mergeContext(e, t) {
  return e === void 0 ? t : t === void 0 ? e : [...e, ...t];
}
function parseClientContextField(e) {
  if (e !== void 0) {
    if (typeof e == `string`)
      return e.length > 0 ? [toClientContextMessage(e)] : void 0;
    if (Array.isArray(e))
      return e.length === 0
        ? void 0
        : e.every((e) => typeof e == `string` && e.length > 0)
          ? e.map((e) => toClientContextMessage(e))
          : Response.json(
              {
                error: `Expected 'clientContext' array entries to be non-empty strings.`,
                ok: !1,
              },
              { status: 400 },
            );
    if (typeof e != `object` || !e)
      return Response.json(
        {
          error: `Expected 'clientContext' to be a string, string array, or JSON object.`,
          ok: !1,
        },
        { status: 400 },
      );
    try {
      let t = parseJsonObject(e);
      return [toClientContextMessage(JSON.stringify(t))];
    } catch {
      return Response.json(
        {
          error: `Expected 'clientContext' to be a JSON-serializable object.`,
          ok: !1,
        },
        { status: 400 },
      );
    }
  }
}
function toClientContextMessage(e) {
  return `Client context:
${e}`;
}
function parseIncludeTailIndex(e) {
  let t = new URL(e.url).searchParams.get(`includeTailIndex`);
  return t === `1` || t === `true`;
}
function parseStartIndex(e) {
  let t = new URL(e.url).searchParams.get(`startIndex`);
  if (t === null) return;
  let n = Number(t);
  return !/^-?\d+$/.test(t) || !Number.isSafeInteger(n)
    ? Response.json(
        { error: `Expected startIndex to be an integer.`, ok: !1 },
        { status: 400 },
      )
    : n;
}
function serializeAsNdjson(e) {
  let t = new TextEncoder();
  return e.pipeThrough(
    new TransformStream({
      start(e) {
        e.enqueue(
          t.encode(`
`),
        );
      },
      transform(e, n) {
        n.enqueue(t.encode(`${JSON.stringify(e)}\n`));
      },
    }),
  );
}
export { defaultEveAuth, eveChannel };
