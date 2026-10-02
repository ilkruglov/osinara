import { getDefaultCodexTokenBroker } from "./token-broker.js";
const CODEX_API_ENDPOINT = `https://chatgpt.com/backend-api/codex/responses`;
function createCodexFetch(n = {}) {
  let r = n.fetch ?? fetch,
    i = n.broker ?? getDefaultCodexTokenBroker(),
    a = n.codexApiEndpoint ?? CODEX_API_ENDPOINT;
  return async (e, t) => {
    let n = rewriteCodexEndpoint(requestUrl(e), a),
      o = await i.getToken({ reason: `request` }),
      s = await r(n, authenticatedInit(e, t, o));
    if (s.status !== 401 || !isReplayable(e, t)) return s;
    await s.body?.cancel();
    let c = await i.getToken({ reason: `rejected` });
    return r(n, authenticatedInit(e, t, c));
  };
}
function rewriteCodexEndpoint(e, n = CODEX_API_ENDPOINT) {
  let r = new URL(e);
  return r.pathname.includes(`/v1/responses`) ||
    r.pathname.includes(`/chat/completions`)
    ? n
    : e;
}
function authenticatedInit(e, t, n) {
  let r = cloneHeaders(
    t?.headers ?? (e instanceof Request ? e.headers : void 0),
  );
  return (
    r.delete(`authorization`),
    r.delete(`Authorization`),
    r.set(`authorization`, `Bearer ${n.token}`),
    r.set(`originator`, `eve`),
    n.accountId === void 0
      ? r.delete(`ChatGPT-Account-Id`)
      : r.set(`ChatGPT-Account-Id`, n.accountId),
    fetchInit(e, t, r)
  );
}
function isReplayable(e, t) {
  return e instanceof Request ? !1 : !(t?.body instanceof ReadableStream);
}
function cloneHeaders(e) {
  return new Headers(e);
}
function requestUrl(e) {
  return e instanceof Request ? e.url : e.toString();
}
function fetchInit(e, t, n) {
  return t === void 0
    ? e instanceof Request
      ? {
          body: e.body,
          cache: e.cache,
          credentials: e.credentials,
          headers: n,
          integrity: e.integrity,
          keepalive: e.keepalive,
          method: e.method,
          mode: e.mode,
          redirect: e.redirect,
          referrer: e.referrer,
          referrerPolicy: e.referrerPolicy,
          signal: e.signal,
        }
      : { headers: n }
    : { ...t, headers: n };
}
export { createCodexFetch, rewriteCodexEndpoint };
