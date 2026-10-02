import { createLogger, logError } from "#internal/logging.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import { toErrorMessage } from "#shared/errors.js";
import { SUBAGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import {
  confirmAgentStarted,
  confirmTaskAgentAddress,
  prepareAgentStart,
  rejectAgentEffect,
} from "#harness/handles/transitions.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { buildSubagentRunInput } from "#execution/subagent-tool.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
const log = createLogger(`execution.subagent-start-local`);
async function startLocalSubagent(e) {
  let { action: t, source: n } = e,
    r = createWorkflowRuntime({
      compiledArtifactsSource: e.bundle.compiledArtifactsSource,
      dynamicSubagentAgentConfig: e.dynamicSubagentAgentConfig,
      nodeId: t.nodeId,
    }),
    { childContinuationToken: i, runInput: a } = buildSubagentRunInput({
      action: t,
      auth: e.auth,
      batchEvent: e.batchEvent,
      capabilities: e.capabilities,
      channelMetadata: e.channelMetadata,
      fanoutSize: e.fanoutSize,
      initiatorAuth: e.initiatorAuth,
      graph: e.bundle.graph,
      parentContinuationToken: e.parentContinuationToken,
      parentTraceContext: e.parentTraceContext,
      persistentSessions: e.persistentSessions,
      sandboxSessionId: e.sandboxSessionId,
      session: e.session,
      source: n,
    }),
    o = n.type === `runtime` ? `agent/self` : `agent/local`,
    { identity: s, operation: c } = mintStartOperation({
      callId: t.callId,
      name: t.subagentName,
      nodeId: t.nodeId,
      parentSessionId: e.session.sessionId,
      parentTurnId: e.batchEvent.turnId,
    }),
    l = prepareAgentStart(e.currentSession, {
      identity: s,
      operation: c,
      target: { continuationToken: i, kind: o },
    }),
    u;
  try {
    u = (await r.createSession(a)).sessionId;
  } catch (e) {
    if (!isRuntimeSessionOwnershipConflictError(e))
      return (
        logError(log, `local subagent start failed`, e, {
          callId: t.callId,
          nodeId: t.nodeId,
          subagentName: t.subagentName,
        }),
        {
          kind: `error`,
          result: {
            callId: t.callId,
            isError: !0,
            kind: `subagent-result`,
            origin: `dispatch`,
            output: { code: SUBAGENT_START_FAILED, message: toErrorMessage(e) },
            subagentName: t.subagentName,
          },
          session: rejectAgentEffect(l, {
            disposition: `dead`,
            operationId: c.id,
          }),
        }
      );
    u = e.ownerSessionId;
  }
  let d = { continuationToken: i, kind: o, sessionId: u };
  return {
    address: d,
    callId: t.callId,
    kind: `called`,
    name: t.name,
    session: e.taskOwned
      ? confirmTaskAgentAddress(l, { address: d, operationId: c.id })
      : confirmAgentStarted(l, { address: d, operationId: c.id }),
    toolName: t.subagentName,
  };
}
export { startLocalSubagent };
