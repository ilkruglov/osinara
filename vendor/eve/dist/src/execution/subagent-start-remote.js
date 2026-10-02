import { createLogger, logError } from "#internal/logging.js";
import {
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import {
  confirmAgentStarted,
  confirmTaskAgentAddress,
  prepareAgentStart,
  rejectAgentEffect,
} from "#harness/handles/transitions.js";
import { createRemoteAgentStartFailureResult } from "#execution/dispatch-action-failures.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
const log = createLogger(`execution.subagent-start-remote`);
async function startRemoteSubagent(e) {
  let { action: r } = e,
    i,
    a;
  try {
    if (e.callbackBaseUrl === void 0)
      throw Error(`Cannot dispatch remote agent without a callback base URL.`);
    ((i = e.callbackBaseUrl),
      (a = resolveRemoteAgentForAction({
        dynamicRemoteAgent: e.dynamicRemoteAgent,
        nodeId: r.nodeId,
        remoteAgentName: r.remoteAgentName,
        registry: e.bundle.subagentRegistry.subagentsByNodeId,
      })));
  } catch (n) {
    return (
      logError(log, `remote agent start failed`, n, {
        remoteAgentName: r.remoteAgentName,
        nodeId: r.nodeId,
        callId: r.callId,
      }),
      {
        kind: `error`,
        result: createRemoteAgentStartFailureResult({ action: r, error: n }),
        session: e.currentSession,
      }
    );
  }
  let { identity: o, operation: s } = mintStartOperation({
      callId: r.callId,
      name: r.remoteAgentName,
      nodeId: r.nodeId,
      parentSessionId: e.session.sessionId,
      parentTurnId: e.batchEvent.turnId,
    }),
    c = prepareAgentStart(e.currentSession, {
      identity: o,
      operation: s,
      target: { callbackBaseUrl: i, kind: `agent/remote`, url: a.url },
    });
  try {
    let t = await startRemoteAgentSession({
        action: r,
        auth: e.auth,
        callbackBaseUrl: i,
        callbackToken: e.parentContinuationToken,
        initiatorAuth: e.initiatorAuth,
        operationId: s.id,
        parentTraceContext: e.parentTraceContext,
        persistentSessions: e.persistentSessions,
        remote: a,
        session: e.session,
      }),
      n = {
        callbackBaseUrl: i,
        kind: `agent/remote`,
        sessionId: t.sessionId,
        url: a.url,
      };
    return {
      address: n,
      callId: r.callId,
      kind: `called`,
      name: r.name,
      session: e.taskOwned
        ? confirmTaskAgentAddress(c, { address: n, operationId: s.id })
        : confirmAgentStarted(c, { address: n, operationId: s.id }),
      toolName: r.remoteAgentName,
    };
  } catch (e) {
    return (
      logError(log, `remote agent start failed`, e, {
        remoteAgentName: r.remoteAgentName,
        nodeId: r.nodeId,
        callId: r.callId,
      }),
      {
        kind: `error`,
        result: createRemoteAgentStartFailureResult({ action: r, error: e }),
        session: rejectAgentEffect(c, {
          disposition: `dead`,
          operationId: s.id,
        }),
      }
    );
  }
}
export { startRemoteSubagent };
