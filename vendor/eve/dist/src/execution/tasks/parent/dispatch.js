import { createLogger, logError } from "#internal/logging.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import {
  TASK_CANCEL_TOOL_NAME,
  TASK_CONTROL_TOOL_NAMES,
  TASK_UPDATE_TOOL_NAME,
} from "#runtime/framework-tools/tasks.js";
import { sendTaskCommand } from "#execution/tasks/parent/run-parent.js";
import { isTerminalTaskStatus } from "#tasks/types.js";
import {
  createTaskControlError,
  createTaskViewsResult,
  createUnknownTasksError,
  findTaskAgentAddress,
  lookupTaskEntries,
  readTaskView,
} from "#execution/tasks/parent/control-shared.js";
import { executeTaskUpdate } from "#execution/tasks/child/update.js";
const log = createLogger(`execution.tasks.dispatch`);
function isTaskControlAction(e) {
  return e.kind === `tool-call` && TASK_CONTROL_TOOL_NAMES.has(e.toolName);
}
async function executeTaskControlAction(e) {
  let { action: t, session: n } = e;
  if (t.toolName === TASK_UPDATE_TOOL_NAME)
    return {
      result: await executeTaskUpdate({
        action: t,
        adapter: e.adapter,
        childStepIndex: e.parentStepIndex ?? 0,
        childTurnId: e.parentTurnId,
        serializedContext: e.serializedContext,
      }),
      session: n,
    };
  let r = readTaskIds(t.input);
  if (r === void 0 || r.length === 0)
    return {
      result: createTaskControlError(t, "Provide a non-empty `taskIds` array."),
      session: n,
    };
  let i = lookupTaskEntries(n, r);
  if (i.kind === `unknown`)
    return { result: createUnknownTasksError(t, i.unknown), session: n };
  let o = i.entries;
  if (t.toolName !== TASK_CANCEL_TOOL_NAME)
    return {
      result: createTaskControlError(
        t,
        `Unsupported task control "${t.toolName}".`,
      ),
      session: n,
    };
  let c = [];
  for (let t of o)
    c.push(await cancelOwnedTask({ bundle: e.bundle, entry: t, session: n }));
  return { result: createTaskViewsResult(t, c), session: n };
}
async function cancelOwnedTask(e) {
  let { entry: t } = e,
    n = await sendTaskCommand({
      command: { kind: `cancel` },
      taskInboxToken: t.taskInboxToken,
    }),
    r = await readTaskView(t);
  for (let e = 0; e < 10 && !isTerminalTaskStatus(r.status); e += 1)
    (await new Promise((e) => setTimeout(e, 250)), (r = await readTaskView(t)));
  if (!isTerminalTaskStatus(r.status))
    throw Error(
      `Task "${t.taskId}" did not commit cancellation before timeout.`,
    );
  let i = r;
  return (
    i.status === `cancelled` &&
      n === `delivered` &&
      (await propagateTaskCancel({
        bundle: e.bundle,
        session: e.session,
        view: i,
      })),
    i
  );
}
async function propagateTaskCancel(e) {
  let a = findTaskAgentAddress(e.session, e.view.metadata.agentId);
  if (a === void 0) return;
  let o = a.address.sessionId,
    s = e.view.executor?.childTurnId;
  if (
    !(
      e.view.executor?.childSessionId !== void 0 &&
      e.view.executor.childSessionId !== o
    )
  )
    try {
      if (a.address.kind === `agent/remote`) {
        let t = resolveRemoteAgentForAction({
            nodeId: a.identity.nodeId,
            remoteAgentName: a.identity.name,
            registry: e.bundle.subagentRegistry.subagentsByNodeId,
          }),
          i = {
            remote: { ...t, url: a.address.url },
            sessionId: o,
            taskId: e.view.taskId,
          };
        (s !== void 0 && (i.turnId = s),
          (await cancelRemoteAgentTurn(i)).status === `no_active_turn` &&
            (await cancelRemoteAgentTurn({
              remote: { ...t, url: a.address.url },
              sessionId: o,
              taskId: e.view.taskId,
            })));
        return;
      }
      let t = { sessionId: o, taskId: e.view.taskId };
      (s !== void 0 && (t.turnId = s),
        (await requestWorkflowTurnCancellation(t)).status ===
          `no_active_turn` &&
          (await requestWorkflowTurnCancellation({
            sessionId: o,
            taskId: e.view.taskId,
          })));
    } catch (n) {
      logError(
        log,
        `task cancel propagation failed; the child may run to completion`,
        n,
        { childSessionId: o, taskId: e.view.taskId },
      );
    }
}
function readTaskIds(e) {
  let t = e.taskIds;
  if (Array.isArray(t))
    return t.filter((e) => typeof e == `string` && e.trim() !== ``);
}
export { cancelOwnedTask, executeTaskControlAction, isTaskControlAction };
