import { ParentSessionKey, ParentTraceContextKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { resolveParentLineage } from "#harness/parent-lineage.js";
import { prepareTurnTraceContext } from "#harness/prepare-trace-context.js";
async function prepareWorkflowPreambleTrace(e) {
  let t = e.ctx.get(ParentSessionKey);
  return await prepareTurnTraceContext({
    agentName: e.runtimeIdentity.agentName,
    instrumentation: getInstrumentationRuntime(),
    parentLineage: resolveParentLineage(t, e.ctx.get(ChannelKey)),
    parentTraceContext: e.ctx.get(ParentTraceContextKey),
    rootSessionId:
      t?.rootSessionId ?? e.session.rootSessionId ?? e.session.sessionId,
    sequence: e.emissionState.sequence,
    sessionId: e.session.sessionId,
    sessionStarted: e.emissionState.sessionStarted,
    turnId: `turn_${e.emissionState.sequence}`,
  });
}
export { prepareWorkflowPreambleTrace };
