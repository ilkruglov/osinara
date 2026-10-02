import { z } from "#compiled/zod/index.js";
const SESSION_TASKS_STATE_KEY = `eve.tasks`,
  taskMetadataSchema = z.strictObject({
    agentId: z.string().min(1),
    kind: z.literal(`subagent`),
    mode: z.enum([`local`, `remote`]),
    name: z.string().min(1),
  }),
  taskViewBaseShape = {
    executor: z
      .strictObject({
        childSessionId: z.string().min(1).optional(),
        childTurnId: z.string().min(1).optional(),
        lifecycle: z.enum([`parked`, `terminal`]).optional(),
      })
      .optional(),
    metadata: taskMetadataSchema,
    taskId: z.string().min(1),
    usage: z
      .strictObject({
        cacheReadTokens: z.number().nonnegative(),
        cacheWriteTokens: z.number().nonnegative(),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
      })
      .optional(),
  },
  taskViewSchema = z.discriminatedUnion(`status`, [
    z.strictObject({
      ...taskViewBaseShape,
      lastOutput: z.strictObject({
        data: z.custom(),
        type: z.literal(`result`),
      }),
      status: z.literal(`completed`),
    }),
    z.strictObject({
      ...taskViewBaseShape,
      lastOutput: z.strictObject({
        data: z.custom(),
        type: z.literal(`error`),
      }),
      status: z.literal(`failed`),
    }),
    z.strictObject({ ...taskViewBaseShape, status: z.literal(`cancelled`) }),
  ]),
  sessionTaskIndexEntrySchema = z.strictObject({
    taskInboxToken: z.string().min(1),
    createdByStepIndex: z.number().int().nonnegative().optional(),
    createdByTurnId: z.string().min(1),
    metadata: taskMetadataSchema,
    operationId: z.string().min(1),
    taskId: z.string().min(1),
    taskRunId: z.string().min(1),
    terminalView: taskViewSchema.optional(),
  }),
  sessionTaskIndexSchema = z
    .strictObject({ tasks: z.array(sessionTaskIndexEntrySchema) })
    .refine(
      (e) => new Set(e.tasks.map((e) => e.taskId)).size === e.tasks.length,
      { message: `Task ids must be unique.` },
    )
    .refine(
      (e) =>
        e.tasks.every(
          (e) =>
            e.terminalView === void 0 ||
            (e.terminalView.taskId === e.taskId &&
              sameTaskMetadata(e.terminalView.metadata, e.metadata)),
        ),
      { message: `Cached terminal views must match their task index entry.` },
    );
function getSessionTaskIndex(e) {
  let n = e?.[SESSION_TASKS_STATE_KEY];
  if (n === void 0) return [];
  let r = sessionTaskIndexSchema.safeParse(n);
  if (!r.success)
    throw Error(
      `Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}": ${r.error.message}`,
    );
  return r.data.tasks;
}
function cacheTerminalTaskView(e, n) {
  if (!isValidTerminalView(n))
    throw Error(`Cannot cache invalid terminal task "${n.taskId}".`);
  let r = getSessionTaskIndex(e),
    i = r.findIndex((e) => e.taskId === n.taskId);
  if (i < 0) return e;
  if (!sameTaskMetadata(r[i].metadata, n.metadata))
    throw Error(`Task view metadata does not match index entry "${n.taskId}".`);
  let a = [...r];
  return (
    (a[i] = { ...a[i], terminalView: n }),
    { ...e, [SESSION_TASKS_STATE_KEY]: { tasks: a } }
  );
}
function isValidTerminalView(e) {
  if (e.inputRequests !== void 0) return !1;
  switch (e.status) {
    case `completed`:
      return e.lastOutput?.type === `result`;
    case `failed`:
      return e.lastOutput?.type === `error`;
    case `cancelled`:
      return e.lastOutput === void 0;
    case `working`:
      return !1;
  }
}
function sameTaskMetadata(e, t) {
  return (
    e.agentId === t.agentId &&
    e.kind === t.kind &&
    e.mode === t.mode &&
    e.name === t.name
  );
}
function findSessionTaskEntry(e, t) {
  return getSessionTaskIndex(e).find((e) => e.taskId === t);
}
function recordSessionTask(e, n) {
  let r = [
    ...getSessionTaskIndex(e.state).filter((e) => e.taskId !== n.taskId),
    n,
  ];
  return {
    ...e,
    state: { ...e.state, [SESSION_TASKS_STATE_KEY]: { tasks: r } },
  };
}
export {
  SESSION_TASKS_STATE_KEY,
  cacheTerminalTaskView,
  findSessionTaskEntry,
  getSessionTaskIndex,
  recordSessionTask,
};
