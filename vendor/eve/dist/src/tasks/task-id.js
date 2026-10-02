import { createHash } from "node:crypto";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";
function deriveTaskId(e) {
  return `task_${deriveAgentOperationId(e).slice(0, 24)}`;
}
function deriveTaskInboxToken(t) {
  return `task:${t.taskId}:${createHash(`sha256`).update(`${t.taskId}\0${t.parentContinuationToken}`).digest(`hex`).slice(0, 32)}`;
}
export { deriveTaskId, deriveTaskInboxToken, readTaskIdFromInboxToken };
