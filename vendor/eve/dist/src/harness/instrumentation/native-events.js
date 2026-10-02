import { contextStorage } from "#context/container.js";
import { instrumentChannelDelivery } from "#harness/channel-delivery-instrumentation.js";
import {
  rememberInstrumentationActionScope,
  rememberInstrumentationInputScope,
  takeInstrumentationActionScopeForCall,
  takeInstrumentationInputScope,
} from "#harness/instrumentation/state.js";
import { RuntimeActionSettlementTimesKey } from "#harness/runtime-action-settlement-state.js";
import {
  actionIdempotencyKey,
  inputIdempotencyKey,
  sessionIdempotencyKey,
  turnIdempotencyKey,
} from "#harness/instrumentation/lifecycle.js";
function createInstrumentationHandleEvent(n) {
  if (n.hooks === void 0) return n.handleEvent;
  if (n.handleEvent === void 0) return;
  let r = n.handleEvent,
    i = n.hooks,
    a = new Set(),
    o = new Set(),
    s = n.turnId;
  return async (c, l) => {
    await r(c, l);
    let u = toLifecycleEvent(c, n, s);
    if (
      (c.type === `turn.started` && (s = c.data.turnId),
      c.type === `turn.cancelled` ||
        c.type === `turn.completed` ||
        c.type === `turn.failed` ||
        c.type === `session.completed` ||
        c.type === `session.failed`)
    ) {
      let n = contextStorage.getStore();
      n !== void 0 &&
        (await instrumentChannelDelivery({
          ctx: n,
          error:
            c.type === `turn.failed` || c.type === `session.failed`
              ? Error(c.data.message)
              : void 0,
          errorCode:
            c.type === `turn.failed` || c.type === `session.failed`
              ? c.data.code
              : void 0,
          hooks: i,
          includeTurn:
            c.type === `turn.cancelled` ||
            c.type === `turn.completed` ||
            c.type === `turn.failed`,
          outcome:
            c.type === `turn.failed` || c.type === `session.failed`
              ? `failed`
              : c.type === `turn.cancelled`
                ? `cancelled`
                : `completed`,
        }));
    }
    (u !== void 0 && (await i.publish(u)),
      c.type === `actions.requested`
        ? await publishActionStarts(c, n, i, a)
        : c.type === `action.result`
          ? await publishActionTerminal(c, n, i)
          : c.type === `input.requested` &&
            (await publishInputStarts(c, n, i, o)));
  };
}
async function publishInputStarts(e, t, n, i) {
  let a = t.getAttemptScope?.();
  if (a !== void 0)
    for (let o of e.data.requests) {
      let s = inputIdempotencyKey(t.sessionId, e.data.turnId, o.requestId);
      i.has(s) ||
        (i.add(s),
        rememberInstrumentationInputScope(s, a),
        await n.publish(
          Object.freeze({
            action: Object.freeze({
              callId: o.action.callId,
              name: o.action.toolName,
            }),
            idempotencyKey: s,
            kind: o.kind,
            request: n.capturesContent
              ? Object.freeze({
                  allowFreeform: o.allowFreeform,
                  display: o.display,
                  options: o.options,
                  prompt: o.prompt,
                })
              : void 0,
            requestId: o.requestId,
            scope: a,
            type: `input.requested`,
          }),
        ));
    }
}
async function publishInputResolutions(e) {
  for (let t of e.batch.inputs) {
    let n = inputIdempotencyKey(
        e.sessionId,
        e.batch.event.turnId,
        t.request.requestId,
      ),
      r = takeInstrumentationInputScope(n);
    r !== void 0 &&
      (await e.hooks.publish(
        Object.freeze({
          idempotencyKey: n,
          kind: t.request.kind,
          outcome: t.outcome,
          requestId: t.request.requestId,
          response:
            !e.hooks.capturesContent || t.response === void 0
              ? void 0
              : Object.freeze({
                  optionId: t.response.optionId,
                  text: t.response.text,
                }),
          scope: r,
          type: `input.resolved`,
        }),
      ));
  }
}
async function publishActionStarts(e, t, r, i) {
  let a = t.getAttemptScope?.();
  if (a !== void 0)
    for (let o of e.data.actions) {
      let c = actionIdempotencyKey(t.sessionId, e.data.turnId, o.callId);
      i.has(c) ||
        (i.add(c),
        rememberInstrumentationActionScope(c, a),
        await r.publish(
          Object.freeze({
            callId: o.callId,
            idempotencyKey: c,
            input: r.capturesContent ? o.input : void 0,
            kind: o.kind,
            name: actionName(o),
            scope: a,
            type: `action.started`,
          }),
        ));
    }
}
async function publishActionTerminal(t, n, r) {
  let a = takeInstrumentationActionScopeForCall(
    n.sessionId,
    t.data.result.callId,
  );
  if (a === void 0) return;
  let { idempotencyKey: s, scope: c } = a;
  if (t.data.status === `completed`) {
    await r.publish(
      Object.freeze({
        acceptedAtMs: contextStorage
          .getStore()
          ?.get(RuntimeActionSettlementTimesKey)?.[t.data.result.callId],
        idempotencyKey: s,
        outcome: `completed`,
        output: Object.freeze(
          r.capturesContent
            ? { output: t.data.result.output, type: `result` }
            : { type: `result` },
        ),
        scope: c,
        type: `action.completed`,
        usage: actionUsage(t.data.result),
      }),
    );
    return;
  }
  let l =
    t.data.error === void 0
      ? t.data.result.output
      : Object.assign(Error(t.data.error.message), { code: t.data.error.code });
  await r.publish(
    Object.freeze({
      acceptedAtMs: contextStorage
        .getStore()
        ?.get(RuntimeActionSettlementTimesKey)?.[t.data.result.callId],
      error: l,
      errorCode: t.data.error?.code,
      idempotencyKey: s,
      outcome: t.data.status,
      scope: c,
      type: `action.failed`,
    }),
  );
}
function actionUsage(e) {
  if (
    !(
      e.kind !== `subagent-result` ||
      e.origin !== `child` ||
      e.usage === void 0
    )
  )
    return {
      inputTokenDetails: {
        cacheReadTokens: e.usage.cacheReadTokens,
        cacheWriteTokens: e.usage.cacheWriteTokens,
      },
      inputTokens: e.usage.inputTokens,
      outputTokens: e.usage.outputTokens,
    };
}
function actionName(e) {
  return e.kind === `tool-call`
    ? e.toolName
    : e.kind === `load-skill`
      ? `load_skill`
      : e.name;
}
function toLifecycleEvent(e, t, n) {
  switch (e.type) {
    case `session.started`:
      return {
        agentName: t.agentName,
        channelKind: t.channelKind,
        idempotencyKey: sessionIdempotencyKey(t.sessionId),
        parentTraceContext: t.parentTraceContext,
        rootSessionId: t.rootSessionId ?? t.sessionId,
        sessionId: t.sessionId,
        type: `session.started`,
      };
    case `session.completed`:
    case `session.waiting`:
      return {
        idempotencyKey: sessionIdempotencyKey(t.sessionId),
        sessionId: t.sessionId,
        turnId: n,
        type: e.type,
      };
    case `session.failed`:
      return {
        error: Error(e.data.message),
        idempotencyKey: sessionIdempotencyKey(t.sessionId),
        sessionId: t.sessionId,
        turnId: n,
        type: `session.failed`,
      };
    case `turn.started`:
      return {
        idempotencyKey: turnIdempotencyKey(t.sessionId, e.data.turnId),
        parentLineage: t.parentLineage,
        parentTraceContext: t.parentTraceContext,
        rootSessionId: t.rootSessionId ?? t.sessionId,
        sequence: e.data.sequence,
        sessionId: t.sessionId,
        turnId: e.data.turnId,
        type: `turn.started`,
      };
    case `turn.completed`:
    case `turn.cancelled`:
      return {
        idempotencyKey: turnIdempotencyKey(t.sessionId, e.data.turnId),
        sessionId: t.sessionId,
        turnId: e.data.turnId,
        type: e.type,
      };
    case `turn.failed`:
      return {
        error: Error(e.data.message),
        idempotencyKey: turnIdempotencyKey(t.sessionId, e.data.turnId),
        sessionId: t.sessionId,
        turnId: e.data.turnId,
        type: `turn.failed`,
      };
    default:
      return;
  }
}
export { createInstrumentationHandleEvent, publishInputResolutions };
