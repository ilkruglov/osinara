import { coalesceTurnInputs } from "#harness/messages.js";
const PENDING_INPUT_BATCHES_KEY = `eve.runtime.pendingInputBatches`,
  LEGACY_PENDING_INPUT_BATCH_KEY = `eve.runtime.pendingInputBatch`,
  DEFERRED_STEP_INPUT_KEY = `eve.runtime.deferredStepInput`;
function hasPendingInputBatch(e) {
  return getPendingInputBatches(e).length > 0;
}
function getPendingInputRequestIds(e) {
  return new Set(
    getPendingInputBatches(e).flatMap((e) =>
      e.requests.map((e) => e.requestId),
    ),
  );
}
function coercePendingInputBatch(e) {
  if (typeof e != `object` || !e) return;
  let t = e;
  if (!(!Array.isArray(t.requests) || !Array.isArray(t.responseMessages)))
    return t;
}
function getPendingInputBatches(e) {
  let r = e?.[PENDING_INPUT_BATCHES_KEY];
  if (Array.isArray(r)) {
    let e = r
      .map((e) => coercePendingInputBatch(e))
      .filter((e) => e !== void 0);
    return (assertUniqueRequestIds(e), e);
  }
  let i = coercePendingInputBatch(e?.[LEGACY_PENDING_INPUT_BATCH_KEY]),
    a = i === void 0 ? [] : [i];
  return (assertUniqueRequestIds(a), a);
}
function assertUniqueRequestIds(e) {
  let t = new Set();
  for (let n of e)
    for (let e of n.requests) {
      if (t.has(e.requestId))
        throw TypeError(
          `Internal pending input invariant violated: requestId must be unique across all pending batches: ${JSON.stringify(e.requestId)}.`,
        );
      t.add(e.requestId);
    }
}
function removePendingInputBatches(e, t) {
  let n = new Set(t);
  return setPendingInputBatches(
    e,
    getPendingInputBatches(e.state).filter((e) => !n.has(e)),
  );
}
function setPendingInputBatches(e, r) {
  assertUniqueRequestIds(r);
  let i = { ...e.state };
  return (
    delete i[LEGACY_PENDING_INPUT_BATCH_KEY],
    r.length === 0
      ? delete i[PENDING_INPUT_BATCHES_KEY]
      : (i[PENDING_INPUT_BATCHES_KEY] = r.map((e) => ({
          event: e.event,
          responseAuthRequiredRequestIds: e.responseAuthRequiredRequestIds,
          requests: [...e.requests],
          responseMessages: [...e.responseMessages],
        }))),
    { ...e, state: Object.keys(i).length > 0 ? i : void 0 }
  );
}
function appendPendingInputBatch(e) {
  return setPendingInputBatches(e.session, [
    ...getPendingInputBatches(e.session.state),
    {
      event: e.event,
      responseAuthRequiredRequestIds: e.responseAuthRequiredRequestIds,
      requests: e.requests,
      responseMessages: e.responseMessages,
    },
  ]);
}
function consumeDeferredStepInput(t) {
  let n = getDeferredStepInput(t.session);
  if (n === void 0) return t;
  if (t.preferCurrentInput === !0 && t.input !== void 0)
    return { input: t.input, session: t.session };
  let r = clearDeferredStepInput(t.session);
  return t.input === void 0
    ? { input: n, session: r }
    : { input: coalesceTurnInputs(n, t.input), session: r };
}
function hasDeferredStepInput(e) {
  return getDeferredStepInput(e) !== void 0;
}
function getDeferredStepInput(e) {
  return e.state?.[DEFERRED_STEP_INPUT_KEY];
}
function queueDeferredStepInput(t, n) {
  let i = getDeferredStepInput(t),
    a = i === void 0 ? n : coalesceTurnInputs(i, n),
    o = { ...t.state };
  return ((o[DEFERRED_STEP_INPUT_KEY] = a), { ...t, state: o });
}
function clearDeferredStepInput(e) {
  if (e.state?.[DEFERRED_STEP_INPUT_KEY] === void 0) return e;
  let t = { ...e.state };
  return (
    delete t[DEFERRED_STEP_INPUT_KEY],
    { ...e, state: Object.keys(t).length > 0 ? t : void 0 }
  );
}
export {
  appendPendingInputBatch,
  consumeDeferredStepInput,
  getPendingInputBatches,
  getPendingInputRequestIds,
  hasDeferredStepInput,
  hasPendingInputBatch,
  queueDeferredStepInput,
  removePendingInputBatches,
};
