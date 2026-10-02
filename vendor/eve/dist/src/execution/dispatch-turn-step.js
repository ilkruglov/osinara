import {
  startWorkflowPreferLatest,
  turnWorkflowReference,
} from "#execution/workflow-runtime.js";
import { createTurnWorkflowInput } from "#execution/durable-session-migrations/turn-workflow.js";
import {
  buildTurnAttributes,
  readRootSessionId,
} from "#execution/eve-workflow-attributes.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
async function dispatchTurnStep(e) {
  "use step";
  return {
    runId: (
      await startWorkflowPreferLatest(
        turnWorkflowReference,
        [createTurnWorkflowInput(e)],
        {
          allowReservedAttributes: !0,
          attributes: normalizeEveAttributes(
            buildTurnAttributes({
              parentSessionId: e.sessionState.sessionId,
              requestId:
                e.delivery.kind === `deliver` ? e.delivery.requestId : void 0,
              rootSessionId:
                readRootSessionId(e.serializedContext) ??
                e.sessionState.sessionId,
            }),
          ),
        },
      )
    ).runId,
  };
}
export { dispatchTurnStep };
