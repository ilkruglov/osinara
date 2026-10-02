import { createInputRequestedEvent } from "#protocol/message.js";
import {
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import {
  getProxyInputRequests,
  toProxyInputRequestEntries,
} from "#harness/proxy-input-requests.js";
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/session-limit-continuation.js";
async function emitProxiedInputRequest(i) {
  await i.emit(
    createInputRequestedEvent({
      requests: i.hookPayload.event.requests,
      sequence: i.hookPayload.event.sequence,
      stepIndex: i.hookPayload.event.stepIndex,
      turnId: i.hookPayload.event.turnId,
    }),
  );
  let o = i.session;
  if (i.mode === `conversation`) {
    let e = getHarnessEmissionState(i.session.state),
      a = await emitTurnEpilogue(i.emit, e, i.mode);
    o = setHarnessEmissionState(i.session, a);
  }
  return { entries: toProxyInputRequestEntries(i.hookPayload), session: o };
}
function routeDeliverPayload(e) {
  let t = getProxyInputRequests(e.state),
    n = e.payload.inputResponses ?? [],
    r = new Map(),
    a = [],
    s;
  for (let i of n) {
    let n = t.get(i.requestId);
    if (n === void 0 || e.allowRoute?.(i.requestId, n) === !1) {
      a.push(i);
      continue;
    }
    n.kind === `session-limit` &&
      i.optionId === SESSION_LIMIT_STOP_OPTION_ID &&
      (s = { kind: `cancel-turn` });
    let c =
        n.taskId === void 0
          ? n.childContinuationToken
          : `${n.childContinuationToken}\0${n.childResponseUrl ?? `local`}\0${n.taskId}`,
      l = r.get(c);
    l === void 0
      ? r.set(c, {
          childContinuationToken: n.childContinuationToken,
          parentRequestIds: [i.requestId],
          responses: [toChildInputResponse(i, n)],
          routes: [n],
          ...(n.childResponseUrl !== void 0 && {
            childResponseUrl: n.childResponseUrl,
          }),
          ...(n.taskId !== void 0 && { taskId: n.taskId }),
        })
      : (l.parentRequestIds.push(i.requestId),
        l.responses.push(toChildInputResponse(i, n)),
        l.routes.push(n));
  }
  let c = [...r.values()].map(
      ({
        childContinuationToken: e,
        childResponseUrl: n,
        parentRequestIds: r,
        responses: i,
        routes: a,
        taskId: o,
      }) => {
        let s = new Set(r),
          c = new Set(s);
        for (let n of a)
          if (
            n.batch !== void 0 &&
            batchResolves({
              batch: n.batch,
              childContinuationToken: e,
              entries: t,
              responseIds: s,
            })
          )
            for (let e of n.batch.requestIds) c.add(e);
        return {
          childContinuationToken: e,
          payload: { inputResponses: i },
          retireRequestIds: [...c],
          ...(n !== void 0 && { childResponseUrl: n }),
          ...(o !== void 0 && { taskId: o }),
        };
      },
    ),
    l = {};
  for (let [t, n] of Object.entries(e.payload))
    t === `inputResponses` || n === void 0 || (l[t] = n);
  return (
    a.length > 0 && (l.inputResponses = a),
    {
      forChildren: c,
      forSelf: Object.keys(l).length > 0 ? l : void 0,
      parentAction: s,
    }
  );
}
function batchResolves(e) {
  return (
    e.batch.approvalRequestIds.length === 0 ||
    e.batch.approvalRequestIds.every((t) => {
      let n = e.entries.get(t);
      return n === void 0 || !sameBatch(n, e) || e.responseIds.has(t);
    })
  );
}
function sameBatch(e, t) {
  return (
    e.childContinuationToken === t.childContinuationToken &&
    e.batch?.requestIds.length === t.batch.requestIds.length &&
    e.batch.requestIds.every((e, n) => e === t.batch.requestIds[n])
  );
}
function toChildInputResponse(e, t) {
  return t.childRequestId === void 0
    ? e
    : { ...e, requestId: t.childRequestId };
}
export { emitProxiedInputRequest, routeDeliverPayload };
