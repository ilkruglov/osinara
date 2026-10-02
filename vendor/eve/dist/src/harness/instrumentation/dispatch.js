import { createLogger, formatError } from "#internal/logging.js";
import {
  abandonInstrumentationState,
  instrumentationStateSlot,
  isInstrumentationStateAbandoned,
  releaseAllInstrumentationAttemptState,
  releaseAllInstrumentationState,
  releaseAllInstrumentationTurnState,
  takeInstrumentationActionScopes,
} from "#harness/instrumentation/state.js";
import { withoutInstrumentationContent } from "#harness/instrumentation/content.js";
const log = createLogger(`harness.instrumentation-dispatch`);
function createInstrumentationDispatcher(e, t) {
  let n = t.handlerTimeoutMs ?? 5e3,
    r = normalizeDispatchGroups(e),
    i = new WeakMap(),
    a = [...r.serialBefore, ...r.parallel, ...r.serialAfter].some(
      (e) => e.capture === `content`,
    ),
    publish = async (e) => {
      let t = snapshotInstrumentationEvent(e, i),
        a = t.type === `session.completed` || t.type === `session.failed`,
        o = t.type === `turn.cancelled` || t.type === `turn.failed`;
      if (a || o) {
        let e = takeInstrumentationActionScopes(
            t.sessionId,
            o ? t.turnId : void 0,
          ),
          n = terminalActionFailure(t);
        for (let t of e)
          await publish({
            ...n,
            idempotencyKey: t.idempotencyKey,
            scope: t.scope,
            type: `action.failed`,
          });
      }
      let s,
        visibleEvent = (e) =>
          e.capture === `content`
            ? t
            : ((s ??= withoutInstrumentationContent(t)), s);
      try {
        try {
          for (let e of r.serialBefore)
            await dispatchToProvider(e, t, n, () => visibleEvent(e));
          if (r.parallel.length === 1) {
            let e = r.parallel[0];
            await dispatchToProvider(e, t, n, () => visibleEvent(e));
          } else if (r.parallel.length > 1) {
            let e = (
              await Promise.allSettled(
                r.parallel.map((e) =>
                  dispatchToProvider(e, t, n, () => visibleEvent(e)),
                ),
              )
            ).find((e) => e.status === `rejected`);
            if (e !== void 0) throw e.reason;
          }
        } finally {
          for (let e of r.serialAfter)
            await dispatchToProvider(e, t, n, () => visibleEvent(e));
        }
      } finally {
        releaseTerminalState(t);
      }
    };
  return { capturesContent: a, publish };
}
function snapshotInstrumentationEvent(e, t) {
  return snapshotPlainValue(e, t);
}
function snapshotPlainValue(e, t) {
  if (Array.isArray(e)) {
    let n = t.get(e);
    if (n !== void 0) return n;
    let r = [];
    t.set(e, r);
    for (let n of e) r.push(snapshotPlainValue(n, t));
    return Object.freeze(r);
  }
  if (typeof e != `object` || !e) return e;
  let n;
  try {
    n = Object.getPrototypeOf(e);
  } catch {
    return e;
  }
  if (n !== Object.prototype && n !== null) return e;
  let r = t.get(e);
  if (r !== void 0) return r;
  let i = {};
  t.set(e, i);
  for (let [n, r] of Object.entries(e)) i[n] = snapshotPlainValue(r, t);
  return Object.freeze(i);
}
function normalizeDispatchGroups(e) {
  if (!Array.isArray(e)) {
    let t = e;
    return {
      parallel: t.parallel ?? [],
      serialAfter: t.serialAfter ?? [],
      serialBefore: t.serialBefore ?? [],
    };
  }
  return {
    parallel: [],
    serialAfter: [],
    serialBefore: e.map((e, t) => ({
      ...e,
      name: e.name ?? `provider-${String(t)}`,
    })),
  };
}
async function dispatchToProvider(e, a, o, s) {
  let c = a.type.endsWith(`.started`) || a.type === `input.requested`,
    l = stateOwner(a),
    u = e.name,
    d = e.stateNamespace ?? u;
  if (isInstrumentationStateAbandoned(d, a.idempotencyKey)) return;
  let f = e.events?.[a.type];
  if (f === void 0) return;
  let p = instrumentationStateSlot(d, a.idempotencyKey, l);
  try {
    (await withTimeout(
      () => f(s(), { state: p }),
      o,
      () => {
        (p.revoke(), c && abandonInstrumentationState(d, a.idempotencyKey, l));
      },
    )) ||
      log.warn(`instrumentation provider timed out`, {
        boundary: a.type,
        provider: u,
        timeoutMs: o,
      });
  } catch (e) {
    log.warn(`instrumentation provider failed`, {
      boundary: a.type,
      error: formatError(e),
      provider: u,
    });
  } finally {
    p.revoke();
  }
}
async function withTimeout(e, t, n) {
  let r;
  try {
    return await Promise.race([
      Promise.resolve(e()).then(() => !0),
      new Promise((e) => {
        r = setTimeout(() => {
          (n(), e(!1));
        }, t);
      }),
    ]);
  } finally {
    clearTimeout(r);
  }
}
function stateOwner(e) {
  return e.type === `channel.delivery.started` ||
    e.type === `channel.delivery.cancelled` ||
    e.type === `channel.delivery.completed` ||
    e.type === `channel.delivery.failed`
    ? { sessionId: e.sessionId, turnId: e.turnId }
    : `scope` in e
      ? e.type.startsWith(`action.`) || e.type.startsWith(`input.`)
        ? { sessionId: e.scope.sessionId, turnId: e.scope.turnId }
        : e.type.startsWith(`model.call.`) ||
            e.type.startsWith(`tool.call.`) ||
            e.type.startsWith(`step.attempt.`)
          ? { attemptId: e.scope.attemptId }
          : {}
      : {};
}
function releaseTerminalState(e) {
  (isTerminal(e.type) && releaseAllInstrumentationState(e.idempotencyKey),
    (e.type === `step.attempt.completed` || e.type === `step.attempt.failed`) &&
      releaseAllInstrumentationAttemptState(e.scope.attemptId),
    (e.type === `session.completed` || e.type === `session.failed`) &&
      releaseAllInstrumentationTurnState(e.sessionId),
    (e.type === `turn.cancelled` || e.type === `turn.failed`) &&
      releaseAllInstrumentationTurnState(e.sessionId, e.turnId));
}
function terminalActionFailure(e) {
  return e.type === `session.failed` || e.type === `turn.failed`
    ? { error: e.error, outcome: `failed` }
    : e.type === `turn.cancelled`
      ? {
          error: Error(`The action was cancelled with its turn.`),
          errorCode: `ACTION_CANCELLED`,
          outcome: `cancelled`,
        }
      : {
          error: Error(`The session completed before the action settled.`),
          errorCode: `ACTION_ABANDONED`,
          outcome: `abandoned`,
        };
}
function isTerminal(e) {
  return (
    e.endsWith(`.completed`) ||
    e.endsWith(`.failed`) ||
    e.endsWith(`.cancelled`) ||
    e === `input.resolved`
  );
}
export { createInstrumentationDispatcher };
