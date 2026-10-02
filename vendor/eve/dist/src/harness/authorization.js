import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import { SessionIdKey } from "#context/keys.js";
import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import { createUlid } from "#shared/ulid.js";
const AUTHORIZATION_BRAND = `__eveAuthorization`,
  AUTHORIZATION_PENDING_BRAND = `__eveAuthorizationPending`;
function requestAuthorization(e) {
  return { [AUTHORIZATION_BRAND]: !0, challenges: e };
}
function redactSignalResume(e) {
  return requestAuthorization(
    e.challenges.map((e) => ({
      attemptId: e.attemptId,
      candidateId: e.candidateId,
      name: e.name,
      challenge: e.challenge,
      hookUrl: e.hookUrl,
    })),
  );
}
function getAuthorizationResult(e) {
  let t = loadContext().get(PendingAuthorizationResultKey);
  if (!(!t || t.length === 0))
    return e === void 0 ? t[0] : t.find((t) => t.name === e);
}
function consumeAuthorizationResult(e) {
  let t = loadContext(),
    r = t.get(PendingAuthorizationResultKey);
  if (!r || r.length === 0) return;
  let i = r.findIndex((t) => t.name === e);
  if (i === -1) return;
  let a = r[i],
    o = r.filter((e, t) => t !== i);
  return (
    t.delete(PendingAuthorizationResultKey),
    o.length > 0 && t.set(PendingAuthorizationResultKey, o),
    a
  );
}
function getHookUrl(r, a) {
  let o = loadContext(),
    s = o.get(SessionIdKey),
    c = o.get(CallbackBaseUrlKey);
  return !s || !c
    ? void 0
    : createWorkflowCallbackUrl(
        c,
        createEveConnectionCallbackRoutePath(r, a, authHookToken(s)),
      );
}
function createAuthorizationAttempt(e) {
  let t = createUlid(),
    n = getHookUrl(e, t);
  return n === void 0 ? void 0 : { attemptId: t, hookUrl: n };
}
function isAuthorizationSignal(e) {
  return typeof e != `object` || !e ? !1 : e[AUTHORIZATION_BRAND] === !0;
}
function isAuthorizationPendingModelOutput(e) {
  return typeof e != `object` || !e
    ? !1
    : e[AUTHORIZATION_PENDING_BRAND] === !0;
}
function authorizationPendingAsJsonObject(e) {
  return { [AUTHORIZATION_PENDING_BRAND]: !0, connections: [...e.connections] };
}
function modelFacingAuthorizationOutput(e) {
  return authorizationPendingAsJsonObject({
    connections: e.challenges.map((e) => e.name),
  });
}
function authorizationPendingModelText(e) {
  return e.length === 0
    ? `Authorization required. Waiting for the user to sign in.`
    : e.length === 1
      ? `Authorization required for ${e[0]}. Waiting for the user to sign in.`
      : `Authorization required for ${e.join(`, `)}. Waiting for the user to sign in.`;
}
function isPendingAuthorizationToolOutput(e) {
  return isAuthorizationPendingModelOutput(e) || isAuthorizationSignal(e);
}
function authHookToken(e) {
  return `${e}:auth`;
}
const PendingAuthorizationResultKey = new ContextKey(
    `eve.pendingAuthorizationResult`,
  ),
  CallbackBaseUrlKey = new ContextKey(`eve.callbackBaseUrl`),
  PENDING_AUTHORIZATION_KEY = `eve.runtime.pendingAuthorization`;
function setPendingAuthorization(e, t) {
  let n = getPendingAuthorization(e)?.challenges ?? [],
    r = getSupersededAuthorizationChallenges(e, t.challenges);
  return {
    ...e,
    [PENDING_AUTHORIZATION_KEY]: {
      challenges: [...n.filter((e) => !r.includes(e)), ...t.challenges],
    },
  };
}
function getSupersededAuthorizationChallenges(e, t) {
  return (getPendingAuthorization(e)?.challenges ?? []).filter((e) =>
    t.some((t) => e.name === t.name && samePrincipal(e.principal, t.principal)),
  );
}
function samePrincipal(e, t) {
  return e === void 0 || t === void 0
    ? e === t
    : e.type === `app` || t.type === `app`
      ? e.type === t.type
      : e.id === t.id && e.issuer === t.issuer;
}
function clearPendingAuthorization(e, t) {
  if (e === void 0 || e[PENDING_AUTHORIZATION_KEY] === void 0) return e;
  if (t !== void 0) {
    if (t.length === 0) return e;
    let n = getPendingAuthorization(e);
    if (n !== void 0) {
      let r = new Set(t),
        i = n.challenges.filter((e) => !r.has(e.attemptId ?? e.name));
      if (i.length > 0)
        return { ...e, [PENDING_AUTHORIZATION_KEY]: { challenges: i } };
    }
  }
  let n = { ...e };
  return (
    delete n[PENDING_AUTHORIZATION_KEY],
    Object.keys(n).length > 0 ? n : void 0
  );
}
function getPendingAuthorization(e) {
  if (!e) return;
  let t = e[PENDING_AUTHORIZATION_KEY];
  if (!(typeof t != `object` || !t)) return t;
}
function hasPendingAuthorization(e) {
  return getPendingAuthorization(e) !== void 0;
}
export {
  CallbackBaseUrlKey,
  PendingAuthorizationResultKey,
  authHookToken,
  authorizationPendingAsJsonObject,
  authorizationPendingModelText,
  clearPendingAuthorization,
  consumeAuthorizationResult,
  createAuthorizationAttempt,
  getAuthorizationResult,
  getHookUrl,
  getPendingAuthorization,
  getSupersededAuthorizationChallenges,
  hasPendingAuthorization,
  isAuthorizationPendingModelOutput,
  isAuthorizationSignal,
  isPendingAuthorizationToolOutput,
  modelFacingAuthorizationOutput,
  redactSignalResume,
  requestAuthorization,
  setPendingAuthorization,
};
