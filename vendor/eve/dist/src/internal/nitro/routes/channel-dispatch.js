import { createAttachSessionFn } from "#channel/session.js";
import { createLogger, logError } from "#internal/logging.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { createChannelOperations } from "#channel/channel-operations.js";
import { getChannelInstrumentationKind } from "#channel/compiled-channel.js";
import {
  createCrossChannelToFn,
  toCrossChannelTargets,
} from "#channel/cross-channel-receive.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";
import { readTrustedDevelopmentClientAddress } from "#internal/nitro/dev-client-address.js";
import {
  attachAgentInfoRouteResponse,
  attachRemoteAgentStreamHeadersResolver,
  attachRouteChannelName,
  attachRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { traceChannelRequest } from "#internal/nitro/routes/channel-request-instrumentation.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { readVercelProjectLink } from "#internal/vercel/project-link.js";
import { withVercelOidcProjectResolver } from "#runtime/governance/auth/vercel-oidc-project.js";
const log = createLogger(`channel.dispatch`);
async function dispatchChannelRequest(e, t, r) {
  return await traceChannelRequest(
    { request: e.req, routeKey: t },
    async (i) => {
      let o = await resolveNitroChannelRuntimeBundle(r),
        s = o.channels.find(
          (e) => `${e.method.toUpperCase()} ${e.urlPath}` === t,
        );
      if (s === void 0)
        return Response.json(
          { error: `No matching channel for this request.`, ok: !1 },
          { status: 404 },
        );
      i?.setAttribute(`eve.channel.name`, s.name);
      let c = getChannelInstrumentationKind(s.definition) ?? s.adapter?.kind;
      c !== void 0 && i?.setAttribute(`eve.channel.kind`, c);
      let l = buildRouteArgs(e, o, s.name, c ?? `channel`, r, i),
        u;
      try {
        u = await withDevelopmentVercelOidcContext(r, e.req, async () => {
          if (s.handler) return await s.handler(e.req, l.args);
          let t = {
            waitUntil: l.args.waitUntil,
            params: l.args.params,
            requestIp: l.args.requestIp,
          };
          return await s.fetch(e.req, t);
        });
      } catch (r) {
        let i = logError(log, `channel handler threw`, r, {
          routeKey: t,
          channel: s.name,
        });
        return (
          flushBackgroundTasks(e, l.backgroundTasks, t, s.name),
          Response.json(
            { error: `Channel handler failed.`, errorId: i, ok: !1 },
            { status: 500 },
          )
        );
      }
      return (flushBackgroundTasks(e, l.backgroundTasks, t, s.name), u);
    },
  );
}
async function dispatchChannelWebSocketRequest(e, t, r) {
  let i = await resolveNitroChannelRuntimeBundle(r),
    o = i.channels.find((e) => `${e.method.toUpperCase()} ${e.urlPath}` === t);
  if (o === void 0 || o.websocket === void 0)
    return rejectWebSocketUpgrade(
      { error: `No matching websocket channel for this request.`, ok: !1 },
      404,
    );
  let s = o.websocket,
    c =
      getChannelInstrumentationKind(o.definition) ??
      o.adapter?.kind ??
      `channel`,
    l = buildRouteArgs(e, i, o.name, c, r, void 0);
  try {
    let n = await withDevelopmentVercelOidcContext(
      r,
      e.req,
      async () => await s(e.req, l.args),
    );
    return (flushBackgroundTasks(e, l.backgroundTasks, t, o.name), n);
  } catch (r) {
    let i = logError(log, `channel websocket handler threw`, r, {
      routeKey: t,
      channel: o.name,
    });
    return (
      flushBackgroundTasks(e, l.backgroundTasks, t, o.name),
      rejectWebSocketUpgrade(
        { error: `Channel websocket handler failed.`, errorId: i, ok: !1 },
        500,
      )
    );
  }
}
async function withDevelopmentVercelOidcContext(e, t, n) {
  return e.kind === `development`
    ? await withVercelOidcProjectResolver(
        {
          request: t,
          resolveCurrentProject: async () => {
            let t = await readVercelProjectLink(e.appRoot);
            return t === void 0
              ? void 0
              : { environment: `development`, projectId: t.projectId };
          },
        },
        n,
      )
    : await n();
}
function buildRouteArgs(t, n, a, c, l, d) {
  let f = readVercelRequestId(t.req.headers),
    p = extractRequestIp(t, l),
    m = [],
    h = t.context.params ?? {},
    g = {};
  for (let [e, t] of Object.entries(h)) g[e] = decodeURIComponent(t);
  let waitUntil = (e) => {
      m.push(e);
    },
    _ = n.channels.find((e) => e.name === a),
    v = _?.adapter ?? { kind: `channel` },
    y = d?.spanContext(),
    b = {
      channelKind: c,
      channelName: a,
      requestId: f,
      requestTraceContext:
        y === void 0
          ? void 0
          : { spanId: y.spanId, traceFlags: y.traceFlags, traceId: y.traceId },
    },
    x = createChannelOperations({
      adapter: v,
      channelName: a,
      metadata: b,
      runtime: n.runtime,
      turnPolicy: _?.turnPolicy,
    }),
    S = createAttachSessionFn(n.runtime, { ...b, turnPolicy: _?.turnPolicy }),
    C = createCrossChannelToFn(n.runtime, toCrossChannelTargets(n.channels)),
    w = attachRouteSessionCreator(
      attachRouteChannelName(
        attachAgentInfoRouteResponse(
          { attachSession: S, ...x, params: g, requestIp: p, to: C, waitUntil },
          async () => {
            let { handleAgentInfoRequest: e } = await import(
              `#internal/nitro/routes/info.js`
            );
            return await e(l);
          },
        ),
        a,
      ),
      async (e) =>
        await n.runtime.createSession({
          ...e,
          adapter: v,
          channelName: a,
          continuationToken:
            e.continuationToken === void 0
              ? void 0
              : `${a}:${e.continuationToken}`,
          delivery: createChannelDeliveryMetadata(b),
          requestId: f,
        }),
    );
  return (
    n.resolveRemoteAgentStreamHeaders !== void 0 &&
      attachRemoteAgentStreamHeadersResolver(
        w,
        n.resolveRemoteAgentStreamHeaders,
      ),
    { args: w, backgroundTasks: m }
  );
}
function readVercelRequestId(e) {
  let t = e.get(`x-vercel-id`)?.trim();
  return t === `` ? void 0 : t;
}
function rejectWebSocketUpgrade(e, t) {
  return {
    upgrade() {
      throw Response.json(e, { status: t });
    },
  };
}
function flushBackgroundTasks(e, t, r, i) {
  t.length !== 0 &&
    e.waitUntil(
      Promise.allSettled(t).then((e) => {
        for (let t of e)
          t.status === `rejected` &&
            logError(log, `channel background task failed`, t.reason, {
              routeKey: r,
              channel: i,
            });
      }),
    );
}
function extractRequestIp(e, t) {
  if (t.kind === `development`) {
    let t = readTrustedDevelopmentClientAddress(
      e.req.headers,
      process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV],
    );
    if (t !== void 0) return t;
  }
  return extractSocketIp(e);
}
function extractSocketIp(e) {
  let t = e.req.ip;
  return typeof t == `string` && t.length > 0 ? t : null;
}
export { dispatchChannelRequest, dispatchChannelWebSocketRequest };
