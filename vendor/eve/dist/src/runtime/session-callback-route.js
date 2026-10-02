import { z } from "#compiled/zod/index.js";
import { EVE_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import { isInputRequest } from "#runtime/input/types.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
import { REMOTE_AGENT_FAILED } from "#harness/agent-handle-errors.js";
import { readTaskIdFromInboxToken } from "#tasks/task-id.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { tokenUsageSchema } from "#shared/token-usage.js";
import { agentTurnOutcomeSchema } from "#shared/agent-turn-outcome.js";
const HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX = `eve/v1/callback`,
  HANDLED_METHODS = [`POST`],
  ZERO_TOKEN_USAGE = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  },
  eventCoordinateSchema = z.number().int().nonnegative(),
  authorizationChallengeSchema = z.looseObject({
    displayName: z.string().optional(),
    expiresAt: z.string().optional(),
    instructions: z.string().optional(),
    url: z.string().optional(),
    userCode: z.string().optional(),
  }),
  taskInputEventSchema = z.looseObject({
    requests: z.array(jsonValueSchema.refine(isInputRequest)).min(1),
    sequence: eventCoordinateSchema,
    stepIndex: eventCoordinateSchema,
    turnId: z.string(),
  }),
  taskAuthorizationEventSchema = z.discriminatedUnion(`type`, [
    z.looseObject({
      data: z.looseObject({
        attemptId: z.string().optional(),
        authorization: authorizationChallengeSchema.optional(),
        description: z.string(),
        name: z.string(),
        sequence: eventCoordinateSchema,
        stepIndex: eventCoordinateSchema,
        turnId: z.string(),
        webhookUrl: z.string().optional(),
      }),
      type: z.literal(`authorization.required`),
    }),
    z.looseObject({
      data: z.looseObject({
        attemptId: z.string().optional(),
        authorization: authorizationChallengeSchema.optional(),
        name: z.string(),
        outcome: z.enum([`authorized`, `declined`, `failed`, `timed-out`]),
        reason: z.string().optional(),
        sequence: eventCoordinateSchema,
        stepIndex: eventCoordinateSchema,
        turnId: z.string(),
      }),
      type: z.literal(`authorization.completed`),
    }),
  ]),
  taskEventCallbackSchema = z.discriminatedUnion(`kind`, [
    z.object({
      callId: z.string(),
      childContinuationToken: z.string(),
      childSessionId: z.string(),
      event: taskInputEventSchema,
      kind: z.literal(`task.input-requested`),
      subagentName: z.string(),
      taskId: z.string(),
    }),
    z.object({
      callId: z.string(),
      childContinuationToken: z.string(),
      childSessionId: z.string(),
      event: taskAuthorizationEventSchema,
      kind: z.literal(`task.authorization`),
      subagentName: z.string(),
      taskId: z.string(),
    }),
  ]),
  taskTurnStartedCallbackSchema = z.object({
    kind: z.literal(`turn.started`),
    sessionId: z.string().min(1),
    taskId: z.string().min(1),
    turnId: z.string().min(1),
  }),
  taskUpdateCallbackSchema = z.object({
    callId: z.string().min(1),
    childStepIndex: eventCoordinateSchema,
    childTurnId: z.string().min(1),
    kind: z.literal(`task.update`),
    message: z.string().min(1),
    taskId: z.string().min(1),
  }),
  sessionResultCallbackSchema = z.discriminatedUnion(`kind`, [
    z.object({
      callId: z.string().min(1),
      kind: z.literal(`session.completed`),
      output: jsonValueSchema.optional(),
      subagentName: z.string().min(1),
      usage: z.unknown().optional(),
    }),
    z.object({
      callId: z.string().min(1),
      error: jsonValueSchema.optional(),
      kind: z.literal(`session.failed`),
      subagentName: z.string().min(1),
      usage: z.unknown().optional(),
    }),
    z.object({
      callId: z.string().min(1),
      kind: z.literal(`turn.completed`),
      outcome: agentTurnOutcomeSchema,
      output: jsonValueSchema.optional(),
      subagentName: z.string().min(1),
    }),
    z.object({
      callId: z.string().min(1),
      error: jsonValueSchema,
      kind: z.literal(`turn.failed`),
      outcome: agentTurnOutcomeSchema,
      subagentName: z.string().min(1),
    }),
  ]);
function getSessionCallbackChannelDefinitions() {
  return HANDLED_METHODS.map((e) => buildCallbackChannelDefinition(e));
}
function getSessionCallbackChannelNames() {
  return new Set(HANDLED_METHODS.map(channelNameForMethod));
}
function buildCallbackChannelDefinition(e) {
  let n = channelNameForMethod(e);
  return {
    name: n,
    method: e,
    urlPath: EVE_CALLBACK_ROUTE_PATTERN,
    fetch: handleSessionCallbackRequest,
    logicalPath: `framework://channels/${n}`,
    sourceId: `eve:framework:session-callback-${e.toLowerCase()}`,
    sourceKind: `module`,
  };
}
function channelNameForMethod(e) {
  return `${HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX}/${e.toLowerCase()}`;
}
async function handleSessionCallbackRequest(e, t) {
  let n = t.params.token;
  if (typeof n != `string` || n.length === 0)
    return Response.json(
      { error: `Missing callback token.`, ok: !1 },
      { status: 400 },
    );
  let r;
  try {
    r = await e.json();
  } catch {
    return Response.json(
      { error: `Invalid JSON body.`, ok: !1 },
      { status: 400 },
    );
  }
  let i = projectTaskEvent(r, n);
  if (i instanceof Response) return i;
  if (i !== void 0) {
    try {
      await resumeHook(n, i);
    } catch {
      return Response.json(
        { error: `Session callback not pending.`, ok: !1 },
        { status: 404 },
      );
    }
    return Response.json({ ok: !0 }, { status: 202 });
  }
  let a = projectTaskUpdate(r, n);
  if (a instanceof Response) return a;
  if (a !== void 0) {
    try {
      await resumeHook(n, a);
    } catch {
      return Response.json(
        { error: `Session callback not pending.`, ok: !1 },
        { status: 404 },
      );
    }
    return Response.json({ ok: !0 }, { status: 202 });
  }
  let o = projectTaskTurnStarted(r, n);
  if (o instanceof Response) return o;
  if (o !== void 0) {
    try {
      await resumeHook(n, o);
    } catch {
      return Response.json(
        { error: `Session callback not pending.`, ok: !1 },
        { status: 404 },
      );
    }
    return Response.json({ ok: !0 }, { status: 202 });
  }
  let s = projectSessionCallbackResult(r);
  if (s instanceof Response) return s;
  try {
    await resumeHook(n, { kind: `runtime-action-result`, results: [s] });
  } catch {
    return Response.json(
      { error: `Session callback not pending.`, ok: !1 },
      { status: 404 },
    );
  }
  return Response.json({ ok: !0 }, { status: 202 });
}
function callbackKind(e) {
  if (!(typeof e != `object` || !e)) return Reflect.get(e, `kind`);
}
function projectTaskEvent(e, t) {
  let n = callbackKind(e);
  if (n !== `task.input-requested` && n !== `task.authorization`) return;
  let r = taskEventCallbackSchema.safeParse(e);
  if (!r.success)
    return Response.json(
      { error: `Invalid task event callback.`, ok: !1 },
      { status: 400 },
    );
  let i = r.data,
    a = rejectMismatchedTaskToken(t, i.taskId);
  return a === void 0
    ? i.kind === `task.input-requested`
      ? {
          callId: i.callId,
          childContinuationToken: i.childContinuationToken,
          childSessionId: i.childSessionId,
          event: i.event,
          kind: `subagent-input-request`,
          subagentName: i.subagentName,
        }
      : {
          callId: i.callId,
          childSessionId: i.childSessionId,
          event: i.event,
          kind: `authorization-event`,
          subagentName: i.subagentName,
        }
    : a;
}
function projectTaskTurnStarted(e, t) {
  if (callbackKind(e) !== `turn.started`) return;
  let n = taskTurnStartedCallbackSchema.safeParse(e);
  if (!n.success)
    return Response.json(
      { error: `Invalid task turn-start callback.`, ok: !1 },
      { status: 400 },
    );
  let r = rejectMismatchedTaskToken(t, n.data.taskId);
  return r === void 0
    ? {
        childSessionId: n.data.sessionId,
        childTurnId: n.data.turnId,
        kind: `turn-started`,
        taskId: n.data.taskId,
      }
    : r;
}
function projectTaskUpdate(e, t) {
  if (callbackKind(e) !== `task.update`) return;
  let n = taskUpdateCallbackSchema.safeParse(e);
  if (!n.success)
    return Response.json(
      { error: `Invalid task update callback.`, ok: !1 },
      { status: 400 },
    );
  let r = rejectMismatchedTaskToken(t, n.data.taskId);
  return r === void 0
    ? {
        callId: n.data.callId,
        childStepIndex: n.data.childStepIndex,
        childTurnId: n.data.childTurnId,
        kind: `task-update`,
        message: n.data.message,
      }
    : r;
}
function rejectMismatchedTaskToken(e, t) {
  return readTaskIdFromInboxToken(e) === t
    ? void 0
    : Response.json(
        { error: `Task callback token mismatch.`, ok: !1 },
        { status: 403 },
      );
}
function projectSessionCallbackResult(e) {
  if (typeof e != `object` || !e)
    return Response.json(
      { error: `Expected a JSON object.`, ok: !1 },
      { status: 400 },
    );
  let t = callbackKind(e);
  if (
    t !== `session.completed` &&
    t !== `session.failed` &&
    t !== `turn.completed` &&
    t !== `turn.failed`
  )
    return Response.json(
      { error: `Unsupported callback kind.`, ok: !1 },
      { status: 400 },
    );
  let n = sessionResultCallbackSchema.safeParse(e);
  if (!n.success)
    return Response.json(
      { error: `Invalid session result callback.`, ok: !1 },
      { status: 400 },
    );
  let r = n.data;
  if (r.kind === `session.completed`) {
    let e = r.output ?? ``,
      t = parseCallbackUsage(r.usage),
      n = {
        callId: r.callId,
        kind: `subagent-result`,
        origin: `child`,
        outcome: {
          kind: `terminal`,
          result: { kind: `succeeded`, output: e },
          usageDelta: t ?? ZERO_TOKEN_USAGE,
        },
        output: e,
        subagentName: r.subagentName,
      };
    return t === void 0 ? n : { ...n, usage: t };
  }
  if (r.kind === `session.failed`) {
    let e =
        r.error === void 0
          ? { code: REMOTE_AGENT_FAILED, message: `Remote agent failed.` }
          : r.error,
      t = parseCallbackUsage(r.usage);
    return {
      callId: r.callId,
      isError: !0,
      kind: `subagent-result`,
      origin: `child`,
      outcome: {
        kind: `terminal`,
        result: { error: e, kind: `failed` },
        usageDelta: t ?? ZERO_TOKEN_USAGE,
      },
      output: e,
      subagentName: r.subagentName,
    };
  }
  return r.kind === `turn.completed`
    ? {
        callId: r.callId,
        kind: `subagent-result`,
        origin: `child`,
        outcome: r.outcome,
        output: r.output ?? ``,
        subagentName: r.subagentName,
        usage: r.outcome.usageDelta,
      }
    : {
        callId: r.callId,
        isError: !0,
        kind: `subagent-result`,
        origin: `child`,
        outcome: r.outcome,
        output: r.error,
        subagentName: r.subagentName,
      };
}
function parseCallbackUsage(e) {
  if (e === void 0) return;
  let t = tokenUsageSchema.safeParse(e);
  return t.success ? t.data : void 0;
}
export {
  HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX,
  getSessionCallbackChannelDefinitions,
  getSessionCallbackChannelNames,
  handleSessionCallbackRequest,
};
