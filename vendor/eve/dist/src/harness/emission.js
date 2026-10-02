import {
  createActionPartialEvent,
  createActionResultEvent,
  createActionsRequestedEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createReasoningAppendedEvent,
  createReasoningCompletedEvent,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createStepFailedEvent,
  createStepStartedEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import { createRuntimeActionRequestFromToolCall } from "#harness/runtime-actions.js";
import { hasEmptyDeliverySentinel } from "#shared/empty-delivery.js";
import {
  createRuntimeToolResultFromStepResult,
  createRuntimeToolResultFromToolError,
  createToolResultMessagePartFromToolError,
} from "#harness/action-result-helpers.js";
import {
  createInvalidToolCallInputError,
  isInvalidToolCall,
  resolveProviderToolCallRequest,
} from "#harness/tool-call-input-errors.js";
import { createProviderStreamActionBatch } from "#harness/stream-actions.js";
import { normalizeModelStreamError } from "#harness/model-call-error.js";
import { createOrderedStreamEmitter } from "#harness/ordered-stream-emitter.js";
import { paceDeltaSink } from "./osinara-delta-pacing.js";
import { interruptStreamOnFailure } from "#harness/interruptible-stream.js";
import { isInlineAuthorizationToolResult } from "#harness/inline-tool-authorization.js";
import {
  getHarnessEmissionState,
  isHarnessBetweenTurns,
  setHarnessEmissionState,
} from "#harness/emission-state.js";
async function emitTurnPreamble(e, t, n, r, i) {
  let o = `turn_${n.sequence}`;
  return (
    n.sessionStarted ||
      (await e(createSessionStartedEvent({ runtime: r, trace: i }))),
    await e(
      createTurnStartedEvent({ sequence: n.sequence, trace: i, turnId: o }),
    ),
    t.message !== void 0 &&
      (await e(
        createMessageReceivedEvent({
          message: t.message,
          sequence: n.sequence,
          turnId: o,
        }),
      )),
    { sessionStarted: !0, sequence: n.sequence, stepIndex: 0, turnId: o }
  );
}
async function emitStepStarted(e, t, n, r) {
  await e(
    createStepStartedEvent({
      modelId: n,
      sequence: t.sequence,
      stepIndex: t.stepIndex,
      turnId: t.turnId,
    }),
    r,
  );
}
async function emitStepAndTurnFailed(e, t, n) {
  (await e(
    createStepFailedEvent({
      ...n,
      sequence: t.sequence,
      stepIndex: t.stepIndex,
      turnId: t.turnId,
    }),
  ),
    await e(
      createTurnFailedEvent({ ...n, sequence: t.sequence, turnId: t.turnId }),
    ));
}
async function emitFailedStep(e, t, n) {
  (await emitStepAndTurnFailed(e, t, n), await e(createSessionFailedEvent(n)));
}
async function emitRecoverableFailedTurn(e, t, n) {
  return (
    await emitStepAndTurnFailed(e, t, n),
    await e(createSessionWaitingEvent()),
    {
      sessionStarted: t.sessionStarted,
      sequence: t.sequence + 1,
      stepIndex: 0,
      turnId: ``,
    }
  );
}
function advanceStep(e) {
  return { ...e, stepIndex: e.stepIndex + 1 };
}
async function emitTurnEpilogue(e, t, n) {
  return (
    await e(
      createTurnCompletedEvent({ sequence: t.sequence, turnId: t.turnId }),
    ),
    n === `conversation`
      ? await e(createSessionWaitingEvent())
      : await e(createSessionCompletedEvent()),
    {
      sessionStarted: t.sessionStarted,
      sequence: t.sequence + 1,
      stepIndex: 0,
      turnId: ``,
    }
  );
}
function normalizeAssistantStepFinishReason(e) {
  switch (e) {
    case `content-filter`:
    case `error`:
    case `length`:
    case `stop`:
    case `tool-calls`:
      return e;
    default:
      return `other`;
  }
}
async function emitStreamContent(e, t, n, r) {
  let i = createOrderedStreamEmitter(paceDeltaSink(e)),
    a = createProviderStreamActionBatch({ emitFn: i.emit, state: t });
  try {
    return await consumeStreamContent(
      i.emit,
      t,
      interruptStreamOnFailure(n, i.failureSignal),
      a,
      r,
    );
  } finally {
    try {
      await a.cancel();
    } finally {
      await i.closeAndDrain();
    }
  }
}
async function consumeStreamContent(a, s, c, l, u) {
  let d = ``,
    f = ``,
    p = `stop`,
    m,
    h = new Set(),
    g = new Set(),
    _ = new Set(),
    v = new Set(),
    y = new Set(),
    b = new Set(),
    x = [],
    S = [],
    flushCurrentMessage = async () => {
      f.length !== 0 &&
        (await a(
          createMessageCompletedEvent({
            finishReason: `tool-calls`,
            message: f,
            sequence: s.sequence,
            stepIndex: s.stepIndex,
            turnId: s.turnId,
          }),
        ),
        (f = ``));
    },
    emitActionRequest = async (e) => {
      g.has(e.callId) ||
        (f.trim().length > 0 && (await flushCurrentMessage()),
        g.add(e.callId),
        await a(
          createActionsRequestedEvent({
            actions: [e],
            sequence: s.sequence,
            stepIndex: s.stepIndex,
            turnId: s.turnId,
          }),
        ));
    },
    collectProviderToolCall = async (e) => {
      if (v.has(e.toolCallId) || (v.add(e.toolCallId), g.has(e.toolCallId)))
        return;
      (g.add(e.toolCallId),
        f.trim().length > 0 && (await flushCurrentMessage()));
      let t = resolveProviderToolCallRequest(e);
      if (t.toolError !== void 0) {
        (b.add(e.toolCallId),
          await emitActionResult(
            createRuntimeToolResultFromToolError(t.toolError),
          ),
          y.add(e.toolCallId),
          S.push(createToolResultMessagePartFromToolError(t.toolError)));
        return;
      }
      l.observe(t.request);
    },
    emitActionResult = async (e) => {
      _.has(e.callId) ||
        (_.add(e.callId),
        await a(
          createActionResultEvent({
            result: e,
            sequence: s.sequence,
            stepIndex: s.stepIndex,
            turnId: s.turnId,
          }),
        ));
    },
    emitActionPartial = async (t) => {
      await a(
        createActionPartialEvent({
          result: t,
          sequence: s.sequence,
          stepIndex: s.stepIndex,
          turnId: s.turnId,
        }),
      );
    },
    emitToolCall = async (e) => {
      if (isInvalidToolCall(e)) {
        b.add(e.toolCallId);
        return;
      }
      if (!(u === void 0 || u.excludedActionToolNames.has(e.toolName)))
        try {
          await emitActionRequest(
            createRuntimeActionRequestFromToolCall({
              toolCall: e,
              tools: u.tools,
            }),
          );
        } catch (t) {
          if (t instanceof TypeError) {
            let n = createInvalidToolCallInputError({ error: t, toolCall: e });
            (b.add(e.toolCallId),
              f.trim().length > 0 && (await flushCurrentMessage()),
              await emitActionResult(createRuntimeToolResultFromToolError(n)),
              y.add(e.toolCallId),
              S.push(createToolResultMessagePartFromToolError(n)));
            return;
          }
          throw t;
        }
    };
  for await (let e of c)
    if (m === void 0)
      switch (e.type) {
        case `reasoning-delta`:
          (await l.flush(),
            (d += e.text),
            await a(
              createReasoningAppendedEvent({
                reasoningDelta: e.text,
                reasoningSoFar: d,
                sequence: s.sequence,
                stepIndex: s.stepIndex,
                turnId: s.turnId,
              }),
            ));
          break;
        case `text-delta`:
          (await l.flush(),
            d.trim().length > 0 &&
              (await a(
                createReasoningCompletedEvent({
                  reasoning: d,
                  sequence: s.sequence,
                  stepIndex: s.stepIndex,
                  turnId: s.turnId,
                }),
              ),
              (d = ``)),
            (f += e.text),
            await a(
              createMessageAppendedEvent({
                messageDelta: e.text,
                messageSoFar: f,
                sequence: s.sequence,
                stepIndex: s.stepIndex,
                turnId: s.turnId,
              }),
            ));
          break;
        case `tool-call`: {
          let t = e;
          (h.add(t.toolCallId),
            t.providerExecuted === !0
              ? await collectProviderToolCall(t)
              : (await l.flush(), await emitToolCall(t)));
          break;
        }
        case `tool-result`: {
          let t = e;
          if (t.preliminary === !0) {
            t.providerExecuted !== !0 &&
              (await emitActionPartial(
                createRuntimeToolResultFromStepResult(t),
              ));
            break;
          }
          if (t.providerExecuted === !0) {
            (await collectProviderToolCall({
              input: `input` in t ? t.input : void 0,
              toolCallId: t.toolCallId,
              toolName: t.toolName,
            }),
              await l.flush(),
              await emitActionResult(createRuntimeToolResultFromStepResult(t)));
            break;
          }
          if (h.has(e.toolCallId)) {
            if (isInlineAuthorizationToolResult(t)) break;
            g.has(e.toolCallId) &&
              (await emitActionResult(createRuntimeToolResultFromStepResult(t)),
              y.add(e.toolCallId));
            break;
          }
          if (
            (await l.flush(),
            await flushCurrentMessage(),
            isInlineAuthorizationToolResult(t))
          ) {
            (y.add(e.toolCallId), x.push(t));
            break;
          }
          (await emitActionResult(createRuntimeToolResultFromStepResult(t)),
            y.add(e.toolCallId));
          break;
        }
        case `tool-error`: {
          let t = e;
          t.providerExecuted === !0
            ? (await collectProviderToolCall(t),
              await l.flush(),
              await emitActionResult(createRuntimeToolResultFromToolError(t)))
            : g.has(t.toolCallId) &&
              (await emitActionResult(createRuntimeToolResultFromToolError(t)),
              y.add(t.toolCallId),
              S.push(createToolResultMessagePartFromToolError(t)));
          break;
        }
        case `finish-step`:
          ((p = normalizeAssistantStepFinishReason(e.finishReason)),
            await l.flush());
          break;
        case `error`:
          m = normalizeModelStreamError(e.error);
          break;
        case `abort`:
          throw new DOMException(
            e.reason ?? `The model stream was aborted.`,
            `AbortError`,
          );
        default:
          break;
      }
  if ((await l.flush(), m !== void 0)) throw m;
  return (
    d.trim().length > 0 &&
      (await a(
        createReasoningCompletedEvent({
          reasoning: d,
          sequence: s.sequence,
          stepIndex: s.stepIndex,
          turnId: s.turnId,
        }),
      )),
    p !== `tool-calls` && hasEmptyDeliverySentinel(f)
      ? await a(
          createMessageCompletedEvent({
            finishReason: p,
            message: null,
            sequence: s.sequence,
            stepIndex: s.stepIndex,
            turnId: s.turnId,
          }),
        )
      : f.trim().length > 0 &&
        (await a(
          createMessageCompletedEvent({
            finishReason: p,
            message: f,
            sequence: s.sequence,
            stepIndex: s.stepIndex,
            turnId: s.turnId,
          }),
        )),
    {
      emittedActionCallIds: g,
      handledInlineToolResultCallIds: y,
      invalidInputToolCallIds: b,
      inlineAuthorizationResults: x,
      trailingInlineToolResultParts: S,
    }
  );
}
export {
  advanceStep,
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitStepStarted,
  emitStreamContent,
  emitTurnEpilogue,
  emitTurnPreamble,
  getHarnessEmissionState,
  isHarnessBetweenTurns,
  normalizeAssistantStepFinishReason,
  setHarnessEmissionState,
};
