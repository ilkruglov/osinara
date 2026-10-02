import { resolveToolCallInputObject } from "#harness/runtime-actions.js";
function createRuntimeToolCallActionFromToolCall(e) {
  return {
    callId: e.toolCall.toolCallId,
    input: resolveToolCallInputObject(e.toolCall.input, {
      callId: e.toolCall.toolCallId,
      toolName: e.toolCall.toolName,
    }),
    kind: `tool-call`,
    toolName: e.toolCall.toolName,
  };
}
export { createRuntimeToolCallActionFromToolCall };
