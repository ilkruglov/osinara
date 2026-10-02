import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { isTaskOwnedSerializedContext } from "#execution/tasks/child/instructions.js";
import { readSerializedSubagentDepth } from "#harness/subagent-depth.js";
import {
  readChannelRequestId,
  readRootSessionId,
} from "#execution/eve-workflow-attributes.js";
import {
  getWorkflowMetadata,
  getWritable,
} from "#compiled/@workflow/core/index.js";
import { isHookConflictError } from "#execution/hook-ownership.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import {
  bindTurnCallerContextStep,
  notifyCancelledTaskCallerStep,
  notifyDelegatedParentStep,
  notifyTaskTurnStartedStep,
  notifyTurnCallerStep,
  resolveInitialTurnCallerStep,
} from "#execution/delegated-parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#execution/delegated-parent-result.js";
import { nextTurnDelivery } from "#execution/parked-delivery-wait.js";
import { dispatchAndAwaitTurn } from "#execution/turn-dispatch.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { createSessionCommandInbox } from "#execution/session-command-inbox.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session-timeout.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { createSessionTimeoutControl } from "#execution/session-timeout-control.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
async function workflowEntry(e) {
  "use workflow";
  let { workflowRunId: s, workflowStartedAt: c } = getWorkflowMetadata(),
    d = e.serializedContext[`eve.continuationToken`] || ``,
    f = e.serializedContext[`eve.mode`],
    p = e.serializedContext[`eve.capabilities`],
    m = e.serializedContext[`eve.bundle`];
  e.serializedContext[`eve.sessionId`] = s;
  let g = getWritable(),
    y = { caller: void 0, callerResolved: !1, lastSessionState: void 0 };
  try {
    let a = readRootSessionId(e.serializedContext),
      o = readSerializedSubagentDepth(e.serializedContext),
      l = e.serializedContext[`eve.dynamicSubagentAgentConfig`],
      { state: u } = await createSessionStep({
        compiledArtifactsSource: m.source,
        continuationToken: d,
        dynamicSubagentAgentConfig: l,
        inheritedLimits: e.limits,
        nodeId: m.nodeId,
        outputSchema: e.input.outputSchema,
        rootSessionId: a,
        sessionId: s,
        subagentDepth: o,
        taskOwned: isTaskOwnedSerializedContext(e.serializedContext),
      });
    ((y.lastSessionState = u),
      (y.caller = await resolveInitialTurnCallerStep({
        serializedContext: e.serializedContext,
      })),
      (y.callerResolved = !0));
    let h = await runDriverLoop({
      capabilities: p,
      driverWritable: g,
      initialInput: {
        deliveryMetadata:
          e.serializedContext[`eve.channelDelivery`] === void 0
            ? void 0
            : [
                {
                  ...e.serializedContext[`eve.channelDelivery`],
                  payloadIndex: 0,
                },
              ],
        kind: `deliver`,
        payloads: [
          {
            message: e.input.message,
            context: e.input.context,
            outputSchema: e.input.outputSchema,
          },
        ],
        requestId: readChannelRequestId(e.serializedContext),
      },
      crashCleanupState: y,
      mode: f,
      serializedContext: e.serializedContext,
      sessionState: u,
      sessionTimeoutDeadline:
        e.sessionTimeoutMs === !1
          ? void 0
          : new Date(
              c.getTime() + (e.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
            ),
    });
    return h.kind === `result`
      ? h.result
      : await finalizeExpiredSession({
          caller: y.caller,
          driverWritable: g,
          mode: f,
          serializedContext: h.serializedContext,
          sessionState: h.sessionState,
        });
  } catch (t) {
    throw (
      y.lastSessionState !== void 0 &&
        (await terminateChildSessionsStep({
          serializedContext: e.serializedContext,
          sessionState: y.lastSessionState,
        })),
      await emitTerminalSessionFailureStep({
        error: normalizeSerializableError(t),
        parentWritable: g,
        serializedContext: e.serializedContext,
      }),
      f === `task`
        ? (await fireSessionCallbackStep({
            error: normalizeSerializableError(t),
            serializedContext: e.serializedContext,
            status: `failed`,
          }),
          await notifyDelegatedParentStep({
            result: createDelegatedSubagentErrorResult(e.serializedContext, t),
            serializedContext: e.serializedContext,
          }))
        : await notifyTurnCallerStep({
            caller: await resolveCallerForCrash(y, e.serializedContext),
            lifecycle: `terminal`,
            sessionId: s,
            settled: { isError: !0, output: t },
          }),
      createSafeOuterWorkflowError()
    );
  }
}
async function resolveCallerForCrash(e, t) {
  if (e.callerResolved) return e.caller;
  try {
    return await resolveInitialTurnCallerStep({ serializedContext: t });
  } catch {
    return;
  }
}
function createSafeOuterWorkflowError() {
  let e = Error(
    `Agent workflow failed. Inspect the private session trace for details.`,
  );
  return ((e.name = `EveWorkflowFailure`), e);
}
async function runDriverLoop(t) {
  let n = new Map(),
    nextParkedActivity = async (e) => {
      let r = new Set(e.expectedAttemptIds);
      for (let e of n.keys()) r.has(e) || n.delete(e);
      for (;;) {
        if (r.size > 0 && [...r].every((e) => n.has(e))) {
          let e = [...r].map((e) => n.get(e));
          return (n.clear(), { kind: `authorization-resume`, payloads: e });
        }
        let e = await nextTurnDelivery({
          awaitAuthorizationCallbacks: r.size > 0,
          bufferedDeliveries: i,
          bufferedSessionControls: a,
          cancelledTaskIds: o,
          commandInbox: u,
          deferDeliveries: t.mode === `task` && r.size > 0,
          driverWritable: t.driverWritable,
          seenTaskDeliveries: l,
          stateCursor: v,
        });
        if (e.kind !== `authorization`) return e;
        for (let t of e.payloads) {
          let e = t.authorizationCallback;
          typeof e?.attemptId == `string` &&
            r.has(e.attemptId) &&
            !n.has(e.attemptId) &&
            n.set(e.attemptId, t);
        }
        if (e.closed) {
          let e = [...n.values()];
          return (n.clear(), { kind: `authorization-resume`, payloads: e });
        }
      }
    },
    r = 0,
    nextTurnControlToken = () =>
      `${t.sessionState.sessionId}:turn-control:${String(r++)}`,
    i = [],
    a = [],
    o = new Set(),
    l = new Set(),
    u = createSessionCommandInbox(),
    h = sessionCommandHookToken(t.sessionState.sessionId);
  (await u.claimStable(h),
    await u.claimAuthorization(`${t.sessionState.sessionId}:auth`));
  let _ =
      t.sessionTimeoutDeadline === void 0
        ? void 0
        : createSessionTimeoutControl({
            deadline: t.sessionTimeoutDeadline,
            token: h,
          }),
    v = new SessionStateCursor({
      serializedContext: t.serializedContext,
      sessionState: t.sessionState,
    }),
    y,
    runTurn = async (e) => {
      let n = t.crashCleanupState.caller;
      n?.taskId !== void 0 &&
        (l.add(n.taskId),
        await notifyTaskTurnStartedStep({
          caller: n,
          childSessionId: v.sessionState.sessionId,
          childTurnId: activeTurnId(v.sessionState.emissionState),
        }));
      let r = await bindTurnCallerContextStep({
          caller: n,
          serializedContext: v.serializedContext,
        }),
        s = await dispatchAndAwaitTurn({
          bufferedDeliveries: i,
          bufferedSessionControls: a,
          cancelledTaskIds: o,
          capabilities: t.capabilities,
          commandInbox: u,
          controlToken: nextTurnControlToken(),
          delivery: e,
          mode: t.mode,
          parentWritable: t.driverWritable,
          serializedContext: r,
          seenTaskDeliveries: l,
          sessionState: v.sessionState,
        });
      return (
        await y?.(),
        (y = s.dispose),
        v.adoptState(s.action),
        (t.crashCleanupState.lastSessionState = v.sessionState),
        s.action
      );
    };
  try {
    if (t.sessionState.continuationToken)
      try {
        await u.rekeyContinuation(t.sessionState.continuationToken);
      } catch (e) {
        if (!isHookConflictError(e)) throw e;
        return { kind: `result`, result: { output: `` } };
      }
    await _?.start();
    let e = await runTurn(t.initialInput);
    for (;;) {
      if (e.kind === `done`)
        return {
          kind: `result`,
          result: await finalizeDone({
            action: e,
            caller: t.crashCleanupState.caller,
            mode: t.mode,
          }),
        };
      if (e.kind !== `park`)
        throw Error(`Driver received unexpected turn action "${e.kind}".`);
      if (e.cancelled === !0) {
        let e = await settleCancelledTurnStep({
          parentWritable: t.driverWritable,
          serializedContext: v.serializedContext,
          sessionState: v.sessionState,
        });
        v.adoptState(e);
        let n = {
          caller: t.crashCleanupState.caller,
          sessionId: v.sessionState.sessionId,
        };
        (await notifyCancelledTaskCallerStep(
          e.usage === void 0 ? n : { ...n, usage: e.usage },
        ),
          (t.crashCleanupState.lastSessionState = v.sessionState));
      }
      v.sessionState.continuationToken &&
        (await u.rekeyContinuation(v.sessionState.continuationToken));
      let n = e.settled;
      e.cancelled !== !0 && n !== void 0
        ? (await notifyTurnCallerStep({
            caller: t.crashCleanupState.caller,
            lifecycle: `parked`,
            sessionId: v.sessionState.sessionId,
            settled: n,
          }),
          (t.crashCleanupState.caller = void 0))
        : e.cancelled === !0 && (t.crashCleanupState.caller = void 0);
      let r = await nextParkedActivity({
        expectedAttemptIds: e.authorizationAttemptIds ?? [],
      });
      if (
        ((t.crashCleanupState.lastSessionState = v.sessionState),
        r.kind === `authorization-resume`)
      ) {
        e = await runTurn({ kind: `deliver`, payloads: r.payloads });
        continue;
      }
      if (r.kind === `expired`)
        return {
          kind: `expired`,
          serializedContext: v.serializedContext,
          sessionState: v.sessionState,
        };
      if (r.kind === `reset`)
        return (
          await terminateChildSessionsStep({
            serializedContext: v.serializedContext,
            sessionState: v.sessionState,
          }),
          { kind: `result`, result: { output: `` } }
        );
      if (r.kind === `clear` || r.kind === `compact`) {
        e = await runTurn({ kind: r.kind });
        continue;
      }
      if (r.kind === `closed`)
        return { kind: `result`, result: { output: `` } };
      if (r.kind === `cancel-turn`) {
        await cancelDescendantTurnsStep({
          serializedContext: v.serializedContext,
          sessionState: v.sessionState,
        });
        let n = await settleCancelledTurnStep({
          parentWritable: t.driverWritable,
          serializedContext: v.serializedContext,
          sessionState: v.sessionState,
        });
        (v.adoptState(n),
          (e = { ...e, settled: void 0 }),
          (t.crashCleanupState.caller = void 0),
          (t.crashCleanupState.lastSessionState = v.sessionState));
        continue;
      }
      (r.delivery.caller !== void 0 &&
        (t.crashCleanupState.caller = r.delivery.caller),
        (e = await runTurn(r.delivery)));
    }
  } finally {
    (await y?.(), await _?.dispose(), await u.dispose());
  }
}
async function finalizeExpiredSession(e) {
  return (
    await terminateChildSessionsStep({
      serializedContext: e.serializedContext,
      sessionState: e.sessionState,
    }),
    await emitTerminalSessionCompletionStep({
      parentWritable: e.driverWritable,
      serializedContext: e.serializedContext,
    }),
    e.mode === `task`
      ? (await fireSessionCallbackStep({
          output: ``,
          serializedContext: e.serializedContext,
          status: `completed`,
        }),
        await notifyDelegatedParentStep({
          result: createDelegatedSubagentSuccessResult(e.serializedContext, ``),
          serializedContext: e.serializedContext,
        }))
      : await notifyTurnCallerStep({
          caller: e.caller,
          lifecycle: `terminal`,
          sessionId: e.sessionState.sessionId,
          settled: { output: `` },
        }),
    { output: `` }
  );
}
async function finalizeDone(e) {
  let { output: t, serializedContext: n } = e.action,
    r = e.action.isError === !0;
  if (
    (await terminateChildSessionsStep({
      serializedContext: n,
      sessionState: e.action.sessionState,
    }),
    e.mode === `task`)
  )
    (await fireSessionCallbackStep({
      error: r ? t : void 0,
      output: r ? void 0 : t,
      serializedContext: n,
      status: r ? `failed` : `completed`,
      usage: e.action.usage,
    }),
      await notifyDelegatedParentStep({
        result: r
          ? createDelegatedSubagentErrorResult(n, t)
          : createDelegatedSubagentSuccessResult(n, t),
        serializedContext: n,
        usage: e.action.usage,
      }));
  else {
    let n = { output: t, usage: e.action.usageDelta };
    (r && (n.isError = !0),
      await notifyTurnCallerStep({
        caller: e.caller,
        lifecycle: `terminal`,
        sessionId: e.action.sessionState.sessionId,
        settled: n,
      }));
  }
  return { output: t };
}
export { workflowEntry };
