import { createDurableSessionState } from "#execution/durable-session-store.js";
import { dispatchToAgentHandle } from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  emitSubagentCalled,
  prepareRuntimeActionDispatch,
  startSubagent,
} from "#execution/dispatch-runtime-actions-shared.js";
async function dispatchRuntimeActionsStep(n) {
  "use step";
  let r = await prepareRuntimeActionDispatch({
    serializedContext: n.serializedContext,
    sessionState: n.sessionState,
    taskControls: !1,
  });
  if (r === void 0)
    return { results: [], sessionState: n.sessionState, pendingTasks: [] };
  let { batch: i, bundle: a, session: o } = r,
    s = a.resolvedAgent.config?.experimental?.subagentPersistentSessions === !0,
    c = n.parentWritable.getWriter(),
    l = o,
    u = [];
  try {
    for (let e of r.plan) {
      if (e.kind === `reject`) {
        u.push(e.result);
        continue;
      }
      if (e.kind === `task-control`)
        throw Error(`Task-control actions require the task dispatch step.`);
      let t;
      switch (e.kind) {
        case `resume`:
          t = await dispatchToAgentHandle({
            action: e.action,
            agentId: e.agentId,
            bundle: createAgentContinuationBundle({
              action: e.action,
              bundle: a,
              dynamicRemoteAgent: e.dynamicRemoteAgent,
            }),
            currentSession: l,
            parentToken: n.parentContinuationToken ?? o.continuationToken,
            parentTurnId: i.event.turnId,
          });
          break;
        case `start`:
          t = await startSubagent({
            auth: r.auth,
            batchEvent: i.event,
            bundle: a,
            callbackBaseUrl: n.callbackBaseUrl,
            capabilities: r.capabilities,
            channelMetadata: r.channelMetadata,
            currentSession: l,
            fanoutSize: r.fanoutSize,
            initiatorAuth: r.initiatorAuth,
            parentContinuationToken: n.parentContinuationToken,
            parentTraceContext: r.parentTraceContext,
            persistentSessions: s,
            sandboxSessionId: r.sandboxSessionId,
            serializedContext: r.serializedContext,
            session: o,
            taskOwned: !1,
            target: e.target,
          });
          break;
      }
      if (((l = t.session), t.kind === `error`)) {
        u.push(t.result);
        continue;
      }
      await emitSubagentCalled({
        adapter: r.adapter,
        adapterCtx: r.adapterCtx,
        batchEvent: i.event,
        entry: e,
        outcome: t,
        sessionId: o.sessionId,
        writer: c,
      });
    }
  } finally {
    c.releaseLock();
  }
  return {
    results: u,
    sessionState:
      l === o ? n.sessionState : createDurableSessionState({ session: l }),
    pendingTasks: [],
  };
}
export { dispatchRuntimeActionsStep };
