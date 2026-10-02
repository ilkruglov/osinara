import {
  extractCodexAccountIdFromToken,
  extractCodexAccountLabelFromToken,
  readCodexJwtExpirationMs,
} from "./auth.js";
import { CodexAppServerClient } from "./codex-app-server.js";
function createCodexTokenBroker(e = {}) {
  let t = e.appServer ?? new CodexAppServerClient(e),
    n = e.now ?? Date.now,
    i = { kind: `checking` },
    a,
    o;
  return {
    getToken(e) {
      return getToken(e.reason);
    },
    async refreshState() {
      ((i.kind === `signed-out` || i.kind === `reauth-required`) &&
        t.restart?.(),
        (a = void 0));
      try {
        await getToken(`request`);
      } catch {}
      return i;
    },
    state() {
      return i;
    },
  };
  function getToken(e) {
    let t = e === `rejected`;
    if (!t && a !== void 0 && isFresh(a, n())) return Promise.resolve(a);
    if (o !== void 0 && (!t || o.forced)) return o.promise;
    let r = o?.promise,
      i = (
        r === void 0
          ? resolveToken(t)
          : r.catch(() => void 0).then(() => resolveToken(t))
      ).finally(() => {
        o?.promise === i && (o = void 0);
      });
    return ((o = { forced: t, promise: i }), i);
  }
  async function resolveToken(e) {
    try {
      let r = await t.getAuthStatus({ refreshToken: e });
      if (r.authMethod !== `chatgpt` || r.authToken === void 0)
        throw (
          (a = void 0),
          (i = e ? { kind: `reauth-required` } : { kind: `signed-out` }),
          Error(
            "ChatGPT subscription authentication is unavailable. Run `codex login`, then retry.",
          )
        );
      let o = tokenFrom(r.authToken);
      if (!e && !isFresh(o, n())) {
        let e = await t.getAuthStatus({ refreshToken: !0 });
        if (e.authMethod !== `chatgpt` || e.authToken === void 0)
          throw (
            (a = void 0),
            (i = { kind: `reauth-required` }),
            Error(
              "ChatGPT subscription authentication could not be refreshed. Run `codex login`, then retry.",
            )
          );
        return accept(e.authToken);
      }
      return ((a = o), (i = readyState(o)), o);
    } catch (e) {
      throw (
        (i.kind === `checking` || i.kind === `ready`) &&
          (i = {
            kind: `unavailable`,
            reason: e instanceof Error ? e.message : String(e),
          }),
        e
      );
    }
  }
  function accept(e) {
    let t = tokenFrom(e);
    return ((a = t), (i = readyState(t)), t);
  }
}
let defaultBroker;
function getDefaultCodexTokenBroker() {
  return ((defaultBroker ??= createCodexTokenBroker()), defaultBroker);
}
function tokenFrom(r) {
  let i = extractCodexAccountIdFromToken(r),
    a = extractCodexAccountLabelFromToken(r),
    o = readCodexJwtExpirationMs(r);
  return {
    token: r,
    ...(i !== void 0 && { accountId: i }),
    ...(a !== void 0 && { accountLabel: a }),
    ...(o !== void 0 && { expiresAt: o }),
  };
}
function readyState(e) {
  return {
    kind: `ready`,
    ...(e.accountLabel !== void 0 && { accountLabel: e.accountLabel }),
  };
}
function isFresh(e, t) {
  return e.expiresAt === void 0 || e.expiresAt - 3e5 > t;
}
export { createCodexTokenBroker, getDefaultCodexTokenBroker };
