import {
  createEveSessionCancelRoutePath,
  createEveSessionClearRoutePath,
  createEveSessionCompactRoutePath,
  createEveSessionResetRoutePath,
} from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { createClientUrl } from "#client/url.js";
import { CancelTurnResponseSchema } from "#protocol/cancel-turn.js";
import { ClearResponseSchema } from "#protocol/clear-session.js";
import { CompactResponseSchema } from "#protocol/compact-session.js";
import { ResetResponseSchema } from "#protocol/reset-session.js";
async function cancelClientSession(t) {
  let { payload: n, response: r } = await postJson({
      body: t.options,
      context: t.context,
      operation: `Cancel`,
      path: createEveSessionCancelRoutePath(t.sessionId),
    }),
    i = CancelTurnResponseSchema.safeParse(n);
  if (
    !i.success ||
    (i.data.status === `accepted` && i.data.sessionId !== t.sessionId)
  )
    throw Error(`Cancel route returned an invalid response (${r.status}).`);
  return i.data.status === `accepted`
    ? { sessionId: i.data.sessionId, status: `accepted` }
    : { status: `no_active_turn` };
}
async function clearClientSession(e) {
  let { payload: n } = await postJson({
      context: e.context,
      operation: `Clear`,
      path: createEveSessionClearRoutePath(e.sessionId),
    }),
    r = ClearResponseSchema.safeParse(n);
  if (
    !r.success ||
    (r.data.status === `accepted` && r.data.sessionId !== e.sessionId)
  )
    throw Error(`Clear route returned an invalid response.`);
  return r.data.status === `accepted`
    ? { sessionId: r.data.sessionId, status: `accepted` }
    : { status: `no_active_session` };
}
async function compactClientSession(e) {
  let { payload: t } = await postJson({
      context: e.context,
      operation: `Compact`,
      path: createEveSessionCompactRoutePath(e.sessionId),
    }),
    r = CompactResponseSchema.safeParse(t);
  if (
    !r.success ||
    (r.data.status === `accepted` && r.data.sessionId !== e.sessionId)
  )
    throw Error(`Compact route returned an invalid response.`);
  return r.data.status === `accepted`
    ? { sessionId: r.data.sessionId, status: `accepted` }
    : { status: `no_active_session` };
}
async function resetClientSession(e) {
  let { payload: t } = await postJson({
      body: e.options,
      context: e.context,
      operation: `Reset`,
      path: createEveSessionResetRoutePath(e.sessionId),
    }),
    n = ResetResponseSchema.safeParse(t);
  if (
    !n.success ||
    (n.data.status === `reset` && n.data.previousSessionId !== e.sessionId)
  )
    throw Error(`Reset route returned an invalid response.`);
  return n.data.status === `reset`
    ? { previousSessionId: n.data.previousSessionId, status: `reset` }
    : { status: `no_active_session` };
}
async function postJson(e) {
  let t = await e.context.resolveHeaders();
  t.set(`content-type`, `application/json`);
  let n = await fetch(
      createClientUrl(e.context.host, e.path),
      withRedirectPolicy(
        {
          body: e.body === void 0 ? void 0 : JSON.stringify(e.body),
          headers: t,
          method: `POST`,
        },
        e.context.redirect,
      ),
    ),
    r = await n.text();
  if (!n.ok) throw new ClientError(n.status, r, n.headers);
  try {
    return { payload: JSON.parse(r), response: n };
  } catch {
    throw Error(`${e.operation} route returned invalid JSON (${n.status}).`);
  }
}
function withRedirectPolicy(e, t) {
  return t === void 0 ? e : { ...e, redirect: t };
}
export {
  cancelClientSession,
  clearClientSession,
  compactClientSession,
  resetClientSession,
};
