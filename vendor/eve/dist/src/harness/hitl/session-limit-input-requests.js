import {
  isSessionLimitContinuationRequest,
  resolveSessionLimitContinuation,
} from "#harness/session-limit-continuation.js";
import {
  getPendingInputBatches,
  queueDeferredStepInput,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import { buildResolvedInputBatch } from "#harness/input-request-resolution.js";
import {
  appendResolvedBatchTranscript,
  compactStepInput,
  finishResolvedInput,
  responsesForBatches,
} from "#harness/hitl/pending-input-resolution.js";
function isSessionLimitInputBatch(e) {
  let t = e.requests.some((e) => e.kind === `session-limit`);
  if (t && e.requests.some((e) => e.kind !== `session-limit`))
    throw TypeError(
      `Session-limit pending input batches must contain only session-limit requests.`,
    );
  return t;
}
function resolveSessionLimitInput(n) {
  let i = new Set(n.responses.map((e) => e.requestId));
  if (
    !(
      n.pendingBatch.requests.some((e) => i.has(e.requestId)) &&
      n.pendingBatch.requests.every((e) => i.has(e.requestId))
    )
  )
    return {
      deferredMessage: !0,
      outcome: `unresolved`,
      messages: [...n.baseHistory],
      session: queueDeferredStepInput(
        n.session,
        compactStepInput(n.resolvedStepInput),
      ),
    };
  let a = n.batches.filter((e) => e !== n.pendingBatch),
    o = responsesForBatches(n.responses, a),
    s = a.some((t) =>
      t.requests.some((t) => isSessionLimitContinuationRequest(t)),
    ),
    c = [...n.baseHistory];
  appendResolvedBatchTranscript(c, n.pendingBatch, []);
  let l = removePendingInputBatches(n.session, [n.pendingBatch]),
    u = resolveSessionLimitContinuation({
      requests: n.pendingBatch.requests,
      responses: n.responses,
    });
  return finishResolvedInput({
    deferTurnInput: n.deferTurnInput || s,
    leftoverResponses: o,
    limitContinuation: u,
    messages: c,
    resolvedInputs: [
      buildResolvedInputBatch(n.pendingBatch, n.responses),
    ].filter((e) => e !== void 0),
    resolvedStepInput: n.resolvedStepInput,
    session: l,
  });
}
function clearPendingSessionLimitPrompt(t) {
  let r = getPendingInputBatches(t.state).filter(
    (t) =>
      t.requests.length > 0 &&
      t.requests.every((t) => isSessionLimitContinuationRequest(t)),
  );
  return r.length === 0 ? t : removePendingInputBatches(t, r);
}
export {
  clearPendingSessionLimitPrompt,
  isSessionLimitInputBatch,
  resolveSessionLimitInput,
};
