import {
  startWorkflowPreferLatest,
  taskRunWorkflowReference,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import { TASK_VIEW_STREAM_NAMESPACE } from "#tasks/types.js";
const TASK_VIEW_READ_TIMEOUT_MS = 1e4;
async function startTaskRun(n) {
  await startWorkflowPreferLatest(taskRunWorkflowReference, [n]);
}
async function waitForTaskCommandOwner(e) {
  return await waitForCommandHookOwner(e.taskInboxToken);
}
async function sendTaskCommand(e) {
  return (await sendTaskCommandToOwner(e)) === void 0
    ? `unreachable`
    : `delivered`;
}
async function sendTaskCommandToOwner(e) {
  let t = { command: e.command, kind: `task-command` },
    n = Math.max(1, e.retryUnreachable?.attempts ?? 1);
  for (let r = 0; ; r += 1)
    try {
      let n = await resumeHook(e.taskInboxToken, t);
      if (
        typeof n != `object` ||
        !n ||
        !(`runId` in n) ||
        typeof n.runId != `string`
      )
        throw Error(
          `Task inbox hook "${e.taskInboxToken}" returned no owner run id.`,
        );
      return { runId: n.runId };
    } catch (t) {
      if (!isTaskWorkflowTargetGone(t)) throw t;
      if (r + 1 >= n) return;
      await new Promise((t) =>
        setTimeout(t, e.retryUnreachable?.delayMs ?? 250),
      );
    }
}
async function sendTaskInboundPayload(e) {
  try {
    return (await resumeHook(e.taskInboxToken, e.payload), `delivered`);
  } catch (e) {
    if (!isTaskWorkflowTargetGone(e)) throw e;
    return `unreachable`;
  }
}
async function readLatestTaskView(e) {
  let t = getRun(e.taskRunId).getReadable({
      namespace: TASK_VIEW_STREAM_NAMESPACE,
      startIndex: -1,
    }),
    n = await t.getTailIndex(),
    i = t.getReader();
  try {
    return n < 0 ? void 0 : await readWithTimeout(i, `latest task view`);
  } finally {
    (await i.cancel(`eve task view read complete`).catch(() => {}),
      i.releaseLock());
  }
}
async function readWithTimeout(e, t) {
  let n;
  try {
    let r = await Promise.race([
      e.read().then((e) => ({ kind: `read`, read: e })),
      new Promise((e) => {
        n = setTimeout(() => e({ kind: `timeout` }), TASK_VIEW_READ_TIMEOUT_MS);
      }),
    ]);
    if (r.kind === `timeout`)
      throw Error(
        `Timed out reading ${t} after ${TASK_VIEW_READ_TIMEOUT_MS}ms.`,
      );
    return r.read.done ? void 0 : r.read.value;
  } finally {
    n !== void 0 && clearTimeout(n);
  }
}
export {
  readLatestTaskView,
  sendTaskCommand,
  sendTaskCommandToOwner,
  sendTaskInboundPayload,
  startTaskRun,
  waitForTaskCommandOwner,
};
