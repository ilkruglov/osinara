import { createLogger, formatError } from "#internal/logging.js";
import {
  sessionIdempotencyKey,
  turnIdempotencyKey,
} from "#harness/instrumentation/lifecycle.js";
const log = createLogger(`harness.prepare-trace-context`);
async function prepareTurnTraceContext(e) {
  let t;
  if (!e.sessionStarted && e.instrumentation?.prepareSessionTrace !== void 0)
    try {
      t = await e.instrumentation.prepareSessionTrace({
        agentName: e.agentName,
        idempotencyKey: sessionIdempotencyKey(e.sessionId),
        parentTraceContext: e.parentTraceContext,
        rootSessionId: e.rootSessionId,
        sessionId: e.sessionId,
        type: `session.started`,
      });
    } catch (e) {
      warn(`session.started`, e);
    }
  if (e.instrumentation?.prepareTurnTrace !== void 0)
    try {
      t = await e.instrumentation.prepareTurnTrace({
        idempotencyKey: turnIdempotencyKey(e.sessionId, e.turnId),
        parentLineage: e.parentLineage,
        parentTraceContext: e.parentTraceContext,
        rootSessionId: e.rootSessionId,
        sequence: e.sequence,
        sessionId: e.sessionId,
        turnId: e.turnId,
        type: `turn.started`,
      });
    } catch (e) {
      warn(`turn.started`, e);
    }
  return e.traceContext ?? t;
}
function warn(e, n) {
  log.warn(`instrumentation trace preparation failed`, {
    boundary: e,
    error: formatError(n),
  });
}
export { prepareTurnTraceContext };
