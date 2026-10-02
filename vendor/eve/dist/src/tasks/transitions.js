import { isTerminalTaskStatus, readTaskInputRequestId } from "#tasks/types.js";
function terminalView(e, t, n) {
  let r = {
    executor:
      t.lifecycle === void 0
        ? e.executor
        : { ...e.executor, lifecycle: t.lifecycle },
    metadata: e.metadata,
    taskId: e.taskId,
  };
  switch ((t.usage !== void 0 && (r.usage = t.usage), n.status)) {
    case `completed`:
      return { ...r, lastOutput: n.lastOutput, status: `completed` };
    case `failed`:
      return { ...r, lastOutput: n.lastOutput, status: `failed` };
    case `cancelled`:
      return { ...r, status: `cancelled` };
  }
}
function applyTaskTransition(n, r) {
  if (isTerminalTaskStatus(n.status)) {
    if (r.kind === `settle-executor`) {
      let e = { ...n.executor, lifecycle: `terminal` };
      if (sameUsage(n.usage, r.usage) && n.executor?.lifecycle === `terminal`)
        return { outcome: `noop`, view: n };
      let t = { ...n, executor: e };
      return {
        outcome: `accepted`,
        view: r.usage === void 0 ? t : { ...t, usage: r.usage },
      };
    }
    return r.kind === `cancel` && n.status === `cancelled`
      ? { outcome: `noop`, view: n }
      : {
          outcome: `rejected`,
          reason: `Task "${n.taskId}" is already ${n.status}; "${r.kind}" cannot change a terminal task.`,
          view: n,
        };
  }
  switch (r.kind) {
    case `complete`:
      return {
        outcome: `accepted`,
        view: terminalView(n, r, {
          lastOutput: { data: r.data, type: `result` },
          status: `completed`,
        }),
      };
    case `fail`:
    case `reject-dispatch`:
      return {
        outcome: `accepted`,
        view: terminalView(n, r, {
          lastOutput: { data: r.data, type: `error` },
          status: `failed`,
        }),
      };
    case `cancel`:
      return {
        outcome: `accepted`,
        view: terminalView(n, r, { status: `cancelled` }),
      };
    case `settle-executor`:
      return {
        outcome: `rejected`,
        reason: `Task "${n.taskId}" is not terminal; usage settles with its terminal command.`,
        view: n,
      };
    case `require-authorization`: {
      let e = { blockedOn: `authorization`, requestId: r.requestId };
      return n.status === `input_required`
        ? n.inputRequests.some((e) => readTaskInputRequestId(e) === r.requestId)
          ? { outcome: `noop`, view: n }
          : {
              outcome: `accepted`,
              view: { ...n, inputRequests: [...n.inputRequests, e] },
            }
        : {
            outcome: `accepted`,
            view: {
              inputRequests: [e],
              executor: n.executor,
              metadata: n.metadata,
              status: `input_required`,
              taskId: n.taskId,
            },
          };
    }
    case `require-input`:
      return isValidInputRequestBatch(r.inputRequests)
        ? {
            outcome: `accepted`,
            view: {
              inputRequests: r.inputRequests,
              executor: n.executor,
              metadata: n.metadata,
              status: `input_required`,
              taskId: n.taskId,
            },
          }
        : {
            outcome: `rejected`,
            reason: `Task "${n.taskId}" received an invalid input request batch.`,
            view: n,
          };
    case `ready`:
      return { outcome: `accepted`, view: n };
    case `answered`: {
      if (n.status !== `input_required`) return { outcome: `noop`, view: n };
      let e = new Set(r.requestIds),
        i = n.inputRequests,
        a = i.filter((n) => {
          let r = readTaskInputRequestId(n);
          return r === void 0 || !e.has(r);
        });
      return a.length === i.length
        ? { outcome: `noop`, view: n }
        : a.length > 0
          ? {
              outcome: `accepted`,
              view: {
                inputRequests: a,
                executor: n.executor,
                metadata: n.metadata,
                status: `input_required`,
                taskId: n.taskId,
              },
            }
          : {
              outcome: `accepted`,
              view: {
                executor: n.executor,
                metadata: n.metadata,
                status: `working`,
                taskId: n.taskId,
              },
            };
    }
    case `start-turn`:
      return r.taskId === n.taskId
        ? n.executor?.childSessionId !== void 0 &&
          n.executor.childSessionId !== r.childSessionId
          ? {
              outcome: `rejected`,
              reason: `Task child session "${r.childSessionId}" does not match "${n.executor.childSessionId}".`,
              view: n,
            }
          : n.executor?.childSessionId === r.childSessionId &&
              n.executor.childTurnId === r.childTurnId
            ? { outcome: `noop`, view: n }
            : {
                outcome: `accepted`,
                view: {
                  ...n,
                  executor: {
                    ...n.executor,
                    childSessionId: r.childSessionId,
                    childTurnId: r.childTurnId,
                  },
                },
              }
        : {
            outcome: `rejected`,
            reason: `Task turn identity "${r.taskId}" does not match "${n.taskId}".`,
            view: n,
          };
  }
}
function isValidInputRequestBatch(e) {
  if (e.length === 0) return !1;
  let n = e.map(readTaskInputRequestId);
  return (
    n.every((e) => e !== void 0 && e.length > 0) && new Set(n).size === n.length
  );
}
function sameUsage(e, t) {
  return e === void 0 || t === void 0
    ? e === t
    : e?.cacheReadTokens === t.cacheReadTokens &&
        e.cacheWriteTokens === t.cacheWriteTokens &&
        e.inputTokens === t.inputTokens &&
        e.outputTokens === t.outputTokens;
}
export { applyTaskTransition };
