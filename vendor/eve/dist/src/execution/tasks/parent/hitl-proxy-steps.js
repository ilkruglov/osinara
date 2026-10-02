import { createEveTaskInputRoutePath } from "#protocol/routes.js";
import { isInputRequest } from "#runtime/input/types.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { removeTaskAgentAddressFromState } from "#harness/handles/transitions.js";
import { createRemoteTaskInputCallbackUrl } from "#execution/workflow-callback-url.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import {
  createTaskInputRequestId,
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import {
  cacheTerminalTaskView,
  findSessionTaskEntry,
} from "#tasks/session-index.js";
import { isTerminalTaskStatus } from "#tasks/types.js";
import { createTaskInputCapabilityToken } from "#execution/task-input-capability.js";
async function recordTaskInputRequestStep(r) {
  "use step";
  let a = await readDurableSession(r.sessionState),
    o = findSessionTaskEntry(a.state, r.taskId),
    s = (getAgentHandleStore(a.state)?.handles ?? []).find(
      (e) => e.phase === `addressed` && e.identity.id === o?.metadata.agentId,
    );
  if (
    o === void 0 ||
    s?.phase !== `addressed` ||
    s.address.sessionId !== r.hookPayload.childSessionId
  )
    return { accepted: !1, sessionState: r.sessionState };
  let c = await readLatestTaskView({ taskRunId: o.taskRunId }),
    l = r.hookPayload.event.requests.map((e) => e.requestId),
    u =
      c?.inputRequests?.map((e) =>
        typeof e == `object` && e && !Array.isArray(e)
          ? Reflect.get(e, `requestId`)
          : void 0,
      ) ?? [];
  if (
    c?.status !== `input_required` ||
    !r.hookPayload.event.requests.every(isInputRequest) ||
    c.metadata.mode !==
      (s.address.kind === `agent/remote` ? `remote` : `local`) ||
    c.metadata.agentId !== o.metadata.agentId ||
    c.executor?.childSessionId !== r.hookPayload.childSessionId ||
    new Set(l).size !== l.length ||
    l.length !== u.length ||
    l.some((e, t) => e !== u[t])
  )
    return { accepted: !1, sessionState: r.sessionState };
  let d = namespaceTaskInputRequests(r.hookPayload, r.taskId),
    f = toProxyInputRequestEntries(d, r.taskId).map(([e, t], n) => {
      let i = r.hookPayload.event.requests[n].requestId;
      return [e, { ...t, childRequestId: i }];
    });
  if (s.address.kind === `agent/remote`) {
    let t = createRemoteTaskInputCallbackUrl(
      s.address.url,
      createEveTaskInputRoutePath(
        createTaskInputCapabilityToken(r.hookPayload.childContinuationToken),
      ),
    );
    f = f.map(([e, n]) => [e, { ...n, childResponseUrl: t }]);
  }
  let p = upsertProxyInputRequestState({
    entries: f,
    forChildContinuationToken: r.hookPayload.childContinuationToken,
    state: a.state,
  });
  return {
    accepted: !0,
    hookPayload: d,
    sessionState: {
      ...r.sessionState,
      hasProxyInputRequests: !0,
      snapshot: {
        session: { ...a, state: p },
        version: r.sessionState.version,
      },
    },
  };
}
function namespaceTaskInputRequests(e, t) {
  return {
    ...e,
    event: {
      ...e.event,
      requests: e.event.requests.map((e) => ({
        ...e,
        requestId: createTaskInputRequestId(t, e.requestId),
      })),
    },
  };
}
async function acceptTaskAuthorizationEventStep(e) {
  "use step";
  let t = await readDurableSession(e.sessionState),
    r = findSessionTaskEntry(t.state, e.taskId);
  if (r === void 0) return !1;
  let i = (getAgentHandleStore(t.state)?.handles ?? []).find(
    (e) => e.phase === `addressed` && e.identity.id === r.metadata.agentId,
  );
  if (
    i?.phase !== `addressed` ||
    i.address.sessionId !== e.hookPayload.childSessionId
  )
    return !1;
  let a = await readLatestTaskView({ taskRunId: r.taskRunId });
  return (
    a !== void 0 &&
    !isTerminalTaskStatus(a.status) &&
    a.executor?.childSessionId === e.hookPayload.childSessionId &&
    a.metadata.agentId === r.metadata.agentId
  );
}
async function recordTerminalTaskViewsStep(e) {
  "use step";
  let t = await readDurableSession(e.sessionState),
    n = t.state;
  for (let t of e.views)
    ((n = cacheTerminalTaskView(n, t)),
      t.executor?.lifecycle === `terminal` &&
        (n = removeTaskAgentAddressFromState(n, t.metadata.agentId)));
  return n === t.state
    ? e.sessionState
    : {
        ...e.sessionState,
        snapshot: {
          session: { ...t, state: n },
          version: e.sessionState.version,
        },
      };
}
export {
  acceptTaskAuthorizationEventStep,
  recordTaskInputRequestStep,
  recordTerminalTaskViewsStep,
};
