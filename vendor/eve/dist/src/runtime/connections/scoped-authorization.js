import { contextStorage, loadContext } from "#context/container.js";
import {
  consumeAuthorizationResult,
  createAuthorizationAttempt,
  requestAuthorization,
} from "#harness/authorization.js";
import { supportsInteractiveAuthorization } from "#runtime/connections/types.js";
import {
  evictCachedToken,
  readCachedToken,
  writeCachedToken,
} from "#runtime/connections/authorization-tokens.js";
import {
  principalKey,
  resolveConnectionPrincipal,
  resolveConnectionPrincipalFromAuth,
} from "#runtime/connections/principal.js";
const LOCAL_HTTP_VERCEL_CONNECT_HOSTNAMES = new Set([`127.0.0.1`, `[::1]`]);
async function resolveScopedToken(t) {
  let { scope: n, authorization: r, connection: i } = t,
    a = contextStorage.getStore(),
    o = resolveScopedPrincipal(t, a);
  if (a === void 0) return await r.getToken({ connection: i, principal: o });
  let u = principalKey(o),
    d = readCachedToken(a, n, u);
  if (d !== void 0) return d;
  let f = await r.getToken({ connection: i, principal: o });
  return (writeCachedToken(a, n, u, f), f);
}
async function evictScopedToken(t) {
  let { scope: n, authorization: r, connection: i } = t,
    a = contextStorage.getStore();
  if (a === void 0) return;
  let s;
  try {
    ((s = resolveScopedPrincipal(t, a)),
      evictCachedToken(a, n, principalKey(s)));
  } catch {
    return;
  }
  try {
    await r.evict?.({ connection: i, principal: s });
  } catch {}
}
async function completeScopedAuthorization(e) {
  let { scope: r, authorization: i, connection: o } = e;
  if (!supportsInteractiveAuthorization(i)) return !1;
  let s = consumeAuthorizationResult(r);
  if (s === void 0) return !1;
  let u = i,
    d = loadContext(),
    f = s.principal ?? resolveScopedPrincipal(e, d),
    p = await u.completeAuthorization({
      callbackUrl: s.hookUrl,
      connection: o,
      principal: f,
      resume: s.resume,
      callback: s.callback,
    });
  return (writeCachedToken(d, r, principalKey(f), p), !0);
}
async function startScopedAuthorization(e) {
  let { scope: t, authorization: n, connection: o } = e;
  if (!supportsInteractiveAuthorization(n)) return;
  let s = createAuthorizationAttempt(t);
  if (s === void 0) return;
  let c = n,
    l = resolveScopedPrincipal(e),
    u = resolveAuthorizationCallbackUrl({
      authorization: n,
      callbackUrl: s.hookUrl,
    }),
    { challenge: d, resume: f } = await c.startAuthorization({
      callbackUrl: u,
      connection: o,
      principal: l,
    });
  return requestAuthorization([
    {
      attemptId: s.attemptId,
      challenge: stampChallengeDisplayName(d, n),
      hookUrl: u,
      name: t,
      principal: l,
      resume: f,
    },
  ]);
}
function resolveScopedPrincipal(e, t) {
  return e.boundResponder === void 0
    ? resolveConnectionPrincipal(e.scope, e.authorization, t)
    : resolveConnectionPrincipalFromAuth(
        e.scope,
        e.authorization,
        e.boundResponder,
        t,
      );
}
function resolveAuthorizationCallbackUrl(e) {
  if (e.authorization.vercelConnect === void 0) return e.callbackUrl;
  let t;
  try {
    t = new URL(e.callbackUrl);
  } catch {
    return e.callbackUrl;
  }
  return t.protocol !== `http:` ||
    !LOCAL_HTTP_VERCEL_CONNECT_HOSTNAMES.has(t.hostname)
    ? e.callbackUrl
    : ((t.hostname = `localhost`), t.toString());
}
function stampChallengeDisplayName(e, t) {
  let n = t.displayName ?? e.displayName;
  return n === e.displayName ? e : { ...e, displayName: n };
}
export {
  completeScopedAuthorization,
  evictScopedToken,
  resolveAuthorizationCallbackUrl,
  resolveScopedToken,
  stampChallengeDisplayName,
  startScopedAuthorization,
};
