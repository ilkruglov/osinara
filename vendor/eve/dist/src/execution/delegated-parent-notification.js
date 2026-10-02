import { createLogger } from "#internal/logging.js";
import { SessionCallbackKey } from "#context/keys.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { SUBAGENT_EXECUTION_FAILED } from "#harness/agent-handle-errors.js";
import { readTaskIdFromInboxToken } from "#tasks/task-id.js";
import { deserializeContext } from "#context/serialize.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import {
  SUBAGENT_ADAPTER_KIND,
  isSubagentAdapterState,
} from "#execution/subagent-adapter-state.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
const log = createLogger(`execution.delegated-parent-notification`);
async function notifyDelegatedParentStep(e) {
  "use step";
  if (e.result === void 0) return;
  let t = (await deserializeContext(e.serializedContext)).get(ChannelKey);
  if (t?.kind !== SUBAGENT_ADAPTER_KIND) return;
  let n = String(t.state?.parentContinuationToken ?? ``);
  n !== `` &&
    (await resumeHook(n, {
      kind: `runtime-action-result`,
      results: [
        e.usage === void 0
          ? e.result
          : {
              ...e.result,
              outcome: { ...e.result.outcome, usageDelta: e.usage },
              usage: e.usage,
            },
      ],
    }));
}
const ZERO_TOKEN_USAGE = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};
async function notifyTurnCallerStep(e) {
  "use step";
  if (e.caller === void 0) return;
  let t = createSettledTurnResult({
    caller: e.caller,
    lifecycle: e.lifecycle,
    sessionId: e.sessionId,
    settled: e.settled,
  });
  if (e.caller.replyTo.kind === `callback`) {
    await postSettledTurnCallback({
      result: t,
      sessionId: e.sessionId,
      url: e.caller.replyTo.url,
    });
    return;
  }
  await resumeSettledTurnHook(e.caller.replyTo.token, t);
}
async function notifyCancelledTaskCallerStep(e) {
  "use step";
  if (e.caller?.taskId === void 0) return;
  let t = e.usage ?? ZERO_TOKEN_USAGE,
    n = {
      callId: e.caller.callId,
      kind: `subagent-result`,
      origin: `child`,
      outcome: { kind: `parked`, result: { kind: `cancelled` }, usageDelta: t },
      output: ``,
      subagentName: e.caller.subagentName,
    },
    r = e.usage === void 0 ? n : { ...n, usage: e.usage };
  if (e.caller.replyTo.kind === `callback`) {
    await postSettledTurnCallback({
      result: r,
      sessionId: e.sessionId,
      url: e.caller.replyTo.url,
    });
    return;
  }
  await resumeSettledTurnHook(e.caller.replyTo.token, r);
}
async function notifyTaskTurnStartedStep(e) {
  "use step";
  let t = e.caller?.taskId;
  if (e.caller === void 0 || t === void 0) return;
  let n = {
    childSessionId: e.childSessionId,
    childTurnId: e.childTurnId,
    kind: `turn-started`,
    taskId: t,
  };
  if (e.caller.replyTo.kind === `hook`) {
    await resumeHook(e.caller.replyTo.token, n);
    return;
  }
  let r = await postSessionCallbackRequest({
    body: {
      callId: e.caller.callId,
      kind: `turn.started`,
      sessionId: e.childSessionId,
      subagentName: e.caller.subagentName,
      taskId: t,
      turnId: e.childTurnId,
    },
    url: e.caller.replyTo.url,
  });
  if (!r.ok)
    throw Error(`Task turn-start callback failed with HTTP ${r.status}.`);
}
function createSettledTurnResult(e) {
  let t = e.settled.usage ?? ZERO_TOKEN_USAGE;
  if (e.settled.isError === !0) {
    let r = {
      code: SUBAGENT_EXECUTION_FAILED,
      message: toErrorMessage(e.settled.output),
    };
    return {
      callId: e.caller.callId,
      isError: !0,
      kind: `subagent-result`,
      origin: `child`,
      outcome: {
        kind: e.lifecycle,
        result: { error: r, kind: `failed` },
        usageDelta: t,
      },
      output: r,
      subagentName: e.caller.subagentName,
    };
  }
  let i = parseJsonValue(e.settled.output),
    o = {
      callId: e.caller.callId,
      kind: `subagent-result`,
      origin: `child`,
      outcome: {
        kind: e.lifecycle,
        result: { kind: `succeeded`, output: i },
        usageDelta: t,
      },
      output: i,
      subagentName: e.caller.subagentName,
    };
  return e.settled.usage === void 0 ? o : { ...o, usage: e.settled.usage };
}
async function resolveInitialTurnCallerStep(e) {
  "use step";
  let n = e.serializedContext[SessionCallbackKey.name];
  if (n !== void 0) {
    let e = parseSessionCallback(n);
    if (!e.ok)
      throw Error(`Serialized session callback is invalid.`, {
        cause: e.cause,
      });
    return {
      callId: e.callback.callId,
      replyTo: {
        kind: `callback`,
        token: e.callback.token,
        url: e.callback.url,
      },
      subagentName: e.callback.subagentName,
      taskId: e.callback.taskId ?? readTaskIdFromInboxToken(e.callback.token),
    };
  }
  let r = (await deserializeContext(e.serializedContext)).get(ChannelKey);
  if (!(r?.kind !== SUBAGENT_ADAPTER_KIND || !isSubagentAdapterState(r.state)))
    return {
      callId: r.state.callId,
      replyTo: { kind: `hook`, token: r.state.parentContinuationToken },
      subagentName: r.state.subagentName,
      taskId: readTaskIdFromInboxToken(r.state.parentContinuationToken),
    };
}
async function bindTurnCallerContextStep(e) {
  "use step";
  let n = e.caller;
  if (n?.taskId === void 0) return e.serializedContext;
  if (n.replyTo.kind === `callback`)
    return {
      ...e.serializedContext,
      [SessionCallbackKey.name]: {
        callId: n.callId,
        subagentName: n.subagentName,
        taskId: n.taskId,
        token: n.replyTo.token,
        url: n.replyTo.url,
      },
    };
  let r = e.serializedContext[ChannelKey.name];
  if (
    typeof r != `object` ||
    !r ||
    Reflect.get(r, `kind`) !== SUBAGENT_ADAPTER_KIND ||
    !isSubagentAdapterState(Reflect.get(r, `state`))
  )
    throw Error(
      `Task-owned local turn is missing its subagent adapter binding.`,
    );
  let a = Reflect.get(r, `state`);
  return {
    ...e.serializedContext,
    [ChannelKey.name]: {
      ...r,
      state: {
        ...a,
        callId: n.callId,
        parentContinuationToken: n.replyTo.token,
        subagentName: n.subagentName,
      },
    },
  };
}
async function postSettledTurnCallback(e) {
  let { sessionId: t } = e;
  if (e.result.isError === !0) {
    await postCallbackPayload({
      payload: {
        callId: e.result.callId,
        error: e.result.output,
        kind: `turn.failed`,
        outcome: e.result.outcome,
        sessionId: t,
        subagentName: e.result.subagentName,
      },
      url: e.url,
    });
    return;
  }
  await postCallbackPayload({
    payload: {
      callId: e.result.callId,
      kind: `turn.completed`,
      outcome: e.result.outcome,
      output: e.result.output,
      sessionId: t,
      subagentName: e.result.subagentName,
    },
    url: e.url,
  });
}
async function postCallbackPayload(e) {
  let t = await postSessionCallbackRequest({ body: e.payload, url: e.url });
  if (!t.ok) throw Error(`Turn callback failed with HTTP ${t.status}.`);
}
async function resumeSettledTurnHook(e, t) {
  try {
    await resumeHook(e, { kind: `runtime-action-result`, results: [t] });
  } catch (n) {
    if (!HookNotFoundError.is(n)) throw n;
    log.warn(`turn caller hook no longer exists`, {
      callId: t.callId,
      callerToken: e,
    });
  }
}
export {
  bindTurnCallerContextStep,
  notifyCancelledTaskCallerStep,
  notifyDelegatedParentStep,
  notifyTaskTurnStartedStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
};
