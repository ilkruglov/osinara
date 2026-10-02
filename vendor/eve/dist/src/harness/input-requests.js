import { resolveTextToResponses } from "#channel/resolve-text.js";
import { resolveToolCallInputObject } from "#harness/runtime-actions.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import {
  appendPendingInputBatch,
  consumeDeferredStepInput,
  getPendingInputBatches,
  getPendingInputRequestIds,
  hasDeferredStepInput,
  hasPendingInputBatch,
  queueDeferredStepInput,
} from "#harness/pending-input-batches.js";
import { compactStepInput } from "#harness/hitl/pending-input-resolution.js";
import { resolveQuestionOnlyInputBatches } from "#harness/hitl/question-input-requests.js";
import {
  getApprovedTools,
  hasAnsweredApprovalBatch,
  resolveApprovalInputBatches,
} from "#harness/hitl/approval-input-requests.js";
import {
  clearPendingSessionLimitPrompt,
  isSessionLimitInputBatch,
  resolveSessionLimitInput,
} from "#harness/hitl/session-limit-input-requests.js";
function hasStepInput(e) {
  return e === void 0
    ? !1
    : e.message !== void 0 || (e.inputResponses?.length ?? 0) > 0;
}
function hasPendingApprovalBatch(e) {
  return getPendingInputBatches(e.state).some((e) =>
    e.requests.some((e) => isApprovalRequest(e)),
  );
}
function resolvePendingInput(e) {
  let t = [...(e.history ?? e.session.history)],
    n = getPendingInputBatches(e.session.state);
  if (n.length === 0)
    return { outcome: `continue`, messages: t, session: e.session };
  let r = routePendingInput(n),
    i = hasTailApprovalResponse(t),
    o = r.kind === `session-limit` ? r.batch : n.length === 1 ? n[0] : void 0,
    s = o === void 0 ? e.stepInput : resolveTextMessageInput(o, e.stepInput),
    c = canonicalizeInputResponses(s?.inputResponses ?? []);
  if (
    r.kind === `approval` &&
    e.deferMessagesWhileApprovalsPending === !0 &&
    s?.message !== void 0 &&
    !hasAnsweredApprovalBatch(r.approvalBatches, c)
  )
    return {
      deferredMessage: !0,
      outcome: `unresolved`,
      messages: t,
      session: queueDeferredStepInput(e.session, compactStepInput(s)),
    };
  if (c.length === 0 && s?.message === void 0) {
    let n = compactStepInput(s);
    return {
      outcome: `unresolved`,
      messages: t,
      session:
        n.context !== void 0 || n.outputSchema !== void 0
          ? queueDeferredStepInput(e.session, n)
          : e.session,
    };
  }
  let l = {
    baseHistory: t,
    batches: n,
    deferTurnInput: i,
    resolvedStepInput: s,
    responses: c,
    session: e.session,
  };
  switch (r.kind) {
    case `session-limit`:
      return resolveSessionLimitInput({ ...l, pendingBatch: r.batch });
    case `approval`:
      return resolveApprovalInputBatches({
        ...l,
        approvalBatches: r.approvalBatches,
        questionBatches: r.questionBatches,
        resolveApprovalKey: e.resolveApprovalKey,
      });
    case `question`:
      return resolveQuestionOnlyInputBatches(l);
  }
}
function routePendingInput(e) {
  let t = e.map((e) => ({ batch: e, domain: classifyPendingInputBatch(e) })),
    n = t.find(({ domain: e }) => e === `session-limit`)?.batch;
  if (n !== void 0) return { batch: n, kind: `session-limit` };
  let r = t
    .filter(({ domain: e }) => e === `approval`)
    .map(({ batch: e }) => e);
  if (r.length > 0) {
    let t = new Set(r);
    return {
      approvalBatches: r,
      kind: `approval`,
      questionBatches: e.filter((e) => !t.has(e)),
    };
  }
  return { kind: `question` };
}
function classifyPendingInputBatch(e) {
  for (let t of e.requests)
    switch (t.kind) {
      case `question`:
      case `session-limit`:
      case `tool-approval`:
        break;
      default: {
        let e = t.kind;
        throw TypeError(`Unhandled pending input request kind: ${String(e)}`);
      }
    }
  return isSessionLimitInputBatch(e)
    ? `session-limit`
    : e.requests.some((e) => isApprovalRequest(e))
      ? `approval`
      : `question`;
}
function canonicalizeInputResponses(e) {
  let t = new Map();
  for (let n of e) t.set(n.requestId, n);
  return [...t.values()];
}
function hasTailApprovalResponse(e) {
  let t = e.at(-1);
  return (
    t?.role === `tool` &&
    t.content.some((e) => e.type === `tool-approval-response`)
  );
}
function resolveTextMessageInput(t, n) {
  if (typeof n?.message != `string`) return n;
  let r = new Set(t.requests.map((e) => e.requestId));
  if (n.inputResponses?.some((e) => r.has(e.requestId))) return n;
  let i = new Set(t.responseAuthRequiredRequestIds ?? []),
    a = t.requests.filter((e) => !i.has(e.requestId)),
    o = resolveTextToResponses(n.message, a);
  return o.length === 0
    ? n
    : compactStepInput({
        ...n,
        inputResponses: [...(n.inputResponses ?? []), ...o],
        messageConsumed: !0,
        message: void 0,
      });
}
function createRuntimeToolCallActionFromToolCall(e) {
  return {
    callId: e.toolCall.toolCallId,
    input: resolveToolCallInputObject(e.toolCall.input, {
      callId: e.toolCall.toolCallId,
      toolName: e.toolCall.toolName,
    }),
    kind: `tool-call`,
    toolName: e.toolCall.toolName,
  };
}
export {
  appendPendingInputBatch,
  clearPendingSessionLimitPrompt,
  consumeDeferredStepInput,
  createRuntimeToolCallActionFromToolCall,
  getApprovedTools,
  getPendingInputRequestIds,
  hasDeferredStepInput,
  hasPendingApprovalBatch,
  hasPendingInputBatch,
  hasStepInput,
  resolvePendingInput,
};
