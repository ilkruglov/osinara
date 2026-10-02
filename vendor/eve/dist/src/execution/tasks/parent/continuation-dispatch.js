import { AGENT_BUSY } from "#harness/agent-handle-errors.js";
import { createAgentErrorResult } from "#execution/agent-handle-dispatch.js";
import {
  findActiveTaskForAgent,
  findTaskAgentAddress,
} from "#execution/tasks/parent/control-shared.js";
import {
  failDelegatedDispatch,
  rejectDelegatedDispatch,
  settleDelegatedDispatch,
} from "#execution/tasks/parent/delegate.js";
import { describeTaskAgent } from "#execution/tasks/parent/agent-identity.js";
function describeTaskDispatch(e) {
  let t = describeTaskAgent(e),
    n =
      e.agentId === void 0
        ? void 0
        : findTaskAgentAddress(e.session, e.agentId);
  return n === void 0
    ? t
    : { ...t, mode: n.address.kind === `agent/remote` ? `remote` : `local` };
}
async function checkTaskContinuationAvailability(r) {
  let i = await findActiveTaskForAgent(
    r.session,
    r.agentId,
    r.parentTurnId,
    r.parentStepIndex,
  );
  return i === void 0
    ? void 0
    : createAgentErrorResult({
        action: r.action,
        code: AGENT_BUSY,
        message: `Agent "${r.agentId}" is busy with task "${i.view.taskId}" (${i.view.status}).`,
      });
}
async function persistContinuationTaskInParentSession(e) {
  let t = findTaskAgentAddress(e.session, e.agentId);
  if (t !== void 0)
    return settleDelegatedDispatch({
      callId: e.action.callId,
      session: e.session,
      subagentName: t.identity.name,
      task: e.delegated,
    });
}
async function settleTaskDispatchError(e) {
  return (
    (e.persisted !== void 0 && e.outcome.deliveryAmbiguous === !0) ||
      (await (
        e.persisted === void 0 ? rejectDelegatedDispatch : failDelegatedDispatch
      )({ error: e.outcome.result.output, task: e.delegated })),
    e.persisted === void 0
      ? e.outcome.result
      : {
          ...e.outcome.result,
          output: attachTaskId(e.outcome.result.output, e.delegated.taskId),
        }
  );
}
function attachTaskId(e, t) {
  return typeof e == `object` && e && !Array.isArray(e)
    ? { ...e, taskId: t }
    : { error: e, taskId: t };
}
export {
  checkTaskContinuationAvailability,
  describeTaskDispatch,
  persistContinuationTaskInParentSession,
  settleTaskDispatchError,
};
