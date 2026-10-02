import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  trace,
} from "#compiled/@opentelemetry/api/index.js";
import { attemptIdempotencyKey } from "#harness/instrumentation/lifecycle.js";
import {
  contentAttribute,
  genAiInputMessagesAttribute,
  genAiOutputMessagesAttribute,
  genAiSystemInstructionsAttribute,
  messagesContentAttribute,
  systemPromptAttribute,
  textContentAttribute,
  toolResultsContentAttribute,
} from "#tracing/agent-otel-content.js";
import { setAgentUsage } from "#tracing/agent-otel-usage.js";
import { createAgentActionInstrumentation } from "#tracing/agent-action-instrumentation.js";
import { createAgentApprovalInstrumentation } from "#tracing/agent-approval-instrumentation.js";
import { createAgentChannelDeliveryInstrumentation } from "#tracing/agent-channel-delivery-instrumentation.js";
import { createAgentToolInstrumentation } from "#tracing/agent-tool-instrumentation.js";
import { createAgentOtelSessionContext } from "#tracing/agent-otel-session-context.js";
function createAgentOtelInstrumentation(e) {
  let t = e.recordInputs ?? !1,
    f = e.recordOutputs ?? !1,
    p = new WeakMap(),
    m = new Map(),
    h = new WeakMap(),
    g = new WeakMap(),
    _ = createAgentActionInstrumentation({
      frameworkVersion: e.frameworkVersion,
      idGenerator: e.idGenerator,
      recordInputs: t,
      recordOutputs: f,
      resolveTraceContext: async (t) =>
        (await e.stateStore.getTurn(t.scope.sessionId, t.scope.turnId))
          ?.context,
      stateStore: e.stateStore,
      tracer: e.tracer,
    }),
    v = createAgentApprovalInstrumentation({
      actionContextFor: _.contextFor,
      frameworkVersion: e.frameworkVersion,
      idGenerator: e.idGenerator,
      recordInputs: t,
      recordOutputs: f,
      tracer: e.tracer,
    }),
    y = createAgentToolInstrumentation({
      actionContextFor: _.contextFor,
      idGenerator: e.idGenerator,
      recordInputs: t,
      recordOutputs: f,
      resolveFallback: (e) => {
        let t = m.get(e.scope.attemptId) ?? e.scope,
          n = h.get(t)?.step;
        return n === void 0
          ? void 0
          : { context: n.context, spanContext: n.span.spanContext() };
      },
      tracer: e.tracer,
    }),
    {
      ensureSessionContext: b,
      prepareSessionTrace: x,
      prepareTurnTrace: S,
    } = createAgentOtelSessionContext(e),
    onSessionStarted = async (e) => {
      await x(e);
    },
    onTurnStarted = async (e) => {
      await S(e);
    },
    onStepStarted = async (t) => {
      let a = await e.stateStore.getTurn(t.scope.sessionId, t.scope.turnId);
      if (a === void 0) return;
      let o = contextFromSpanContext(a.context),
        s = trace.getSpan(context.active())?.spanContext(),
        c = e.idGenerator.withSpanId(
          e.idGenerator.deriveSpanId(attemptIdempotencyKey(t.scope)),
          () =>
            e.tracer.startSpan(
              `agent.step`,
              {
                attributes: {
                  "agent.session.id": t.scope.sessionId,
                  "agent.framework.name": `eve`,
                  "agent.framework.version": e.frameworkVersion,
                  "agent.root.session.id":
                    t.scope.rootSessionId ?? t.scope.sessionId,
                  "agent.step.attempt": t.scope.attemptIndex,
                  "agent.step.index": t.scope.stepIndex,
                  "agent.turn.id": t.scope.turnId,
                  "agent.name": t.scope.functionId,
                  ...runtimeContextAttributes(t.runtimeContext),
                },
                links:
                  s === void 0 || s.traceId === a.context.traceId
                    ? void 0
                    : [
                        {
                          attributes: { "eve.link.type": `workflow.delivery` },
                          context: s,
                        },
                      ],
              },
              o,
            ),
        );
      c.addEvent(`step.started`);
      let l = trace.setSpan(o, c),
        u = t.operation.operationId,
        d = e.tracer.startSpan(
          u,
          {
            attributes: {
              "ai.operation.name": u,
              "ai.provider.name": t.operation.provider,
              "ai.request.model": t.operation.modelId,
              ...runtimeContextAttributes(t.runtimeContext),
            },
          },
          l,
        );
      (h.set(t.scope, {
        operation: { context: trace.setSpan(l, d), name: u, span: d },
        step: { context: l, span: c },
      }),
        m.set(t.scope.attemptId, t.scope));
    },
    onStepTerminal = async (e) => {
      let t = m.get(e.scope.attemptId) ?? e.scope;
      (p.delete(t),
        drainOpenSpans({ ...e, scope: t }),
        y.drain(
          e.scope.attemptId,
          e.type === `step.attempt.failed` ? { error: e.error } : void 0,
        ),
        e.type === `step.attempt.failed` &&
          (await _.failForAttempt(t, e.error)),
        m.delete(e.scope.attemptId));
      let n = h.get(t);
      n !== void 0 &&
        (n.step.span.addEvent(
          e.type === `step.attempt.completed`
            ? `step.completed`
            : `step.failed`,
        ),
        e.type === `step.attempt.failed` &&
          (recordError(n.operation.span, e.error),
          recordError(n.step.span, e.error)),
        n.operation.span.end(),
        n.step.span.end(),
        h.delete(t));
    },
    onTurnTerminal = async (t) => {
      (t.type === `turn.cancelled` || t.type === `turn.failed`) &&
        (await _.deleteForTurn(t.sessionId, t.turnId));
      let n = await e.stateStore.getTurn(t.sessionId, t.turnId);
      n !== void 0 &&
        (await e.stateStore.setTurn(t.sessionId, t.turnId, {
          ...n,
          terminal:
            t.type === `turn.failed`
              ? { error: t.error, type: t.type }
              : { type: t.type },
        }));
    },
    onSessionTransition = async (t) => {
      if (t.turnId !== void 0) {
        let n = await e.stateStore.getTurn(t.sessionId, t.turnId);
        if (n !== void 0) {
          let r = await e.stateStore.getSession(t.sessionId),
            i = e.idGenerator.withSpanId(n.context.spanId, () =>
              e.tracer.startSpan(
                `agent.turn`,
                {
                  attributes: {
                    "agent.framework.name": `eve`,
                    "agent.framework.version": e.frameworkVersion,
                    "agent.name": r?.agentName,
                    ...parentLineageAttributes(n.lineage),
                    "agent.root.session.id": n.rootSessionId,
                    "agent.session.id": t.sessionId,
                    "agent.session.window": r?.window,
                    "agent.turn.id": t.turnId,
                    "agent.turn.sequence": n.sequence,
                  },
                  startTime: n.startTimeMs,
                },
                contextFromSpanContext({
                  isRemote: n.parentIsRemote ?? !1,
                  spanId: n.parentSpanId,
                  traceFlags: n.context.traceFlags,
                  traceId: n.context.traceId,
                }),
              ),
            );
          (i.addEvent(`turn.started`, void 0, n.startTimeMs),
            n.terminal !== void 0 &&
              (i.addEvent(n.terminal.type),
              n.terminal.type === `turn.failed` &&
                recordError(i, n.terminal.error)),
            i.end(),
            await e.stateStore.deleteTurn(t.sessionId, t.turnId));
        }
      }
      (t.type === `session.completed` || t.type === `session.failed`) &&
        (await _.deleteForSession(t.sessionId),
        await e.stateStore.deleteSession(t.sessionId));
    },
    onModelCallStarted = (n) => {
      let i = h.get(n.scope);
      if (i === void 0) return;
      (i.step.span.setAttribute(`agent.model.id`, n.model.modelId),
        i.step.span.setAttribute(`agent.model.provider`, n.model.provider));
      let a = e.tracer.startSpan(
        modelSpanName(n.model.modelId),
        {
          attributes: {
            "gen_ai.agent.name": n.scope.functionId,
            "gen_ai.operation.name": `chat`,
            "gen_ai.provider.name": n.model.provider,
            "gen_ai.request.model": n.model.modelId,
            ...runtimeContextAttributes(n.runtimeContext),
          },
        },
        i.operation.context,
      );
      if (t && n.input !== void 0) {
        let e = messagesContentAttribute(n.input.messages);
        e !== void 0 && a.setAttribute(`ai.prompt.messages`, e);
        let t = genAiInputMessagesAttribute(n.input.messages);
        t !== void 0 && a.setAttribute(`gen_ai.input.messages`, t);
        let r = systemPromptAttribute(n.input.instructions);
        r !== void 0 && a.setAttribute(`ai.prompt.system`, r);
        let i = genAiSystemInstructionsAttribute(n.input.instructions);
        i !== void 0 && a.setAttribute(`gen_ai.system_instructions`, i);
      }
      let s = { context: trace.setSpan(i.operation.context, a), span: a };
      (getExecutionContexts(n.scope).set(n.idempotencyKey, s.context),
        getSpanStates(g, n.scope).set(n.idempotencyKey, s));
    },
    onModelCallTerminal = (e) => {
      p.get(e.scope)?.delete(e.idempotencyKey);
      let t = takeSpanState(g, e.scope, e.idempotencyKey);
      if (t !== void 0) {
        if (e.type === `model.call.failed`) recordError(t.span, e.error);
        else {
          (setAgentUsage(t.span, e.usage),
            t.span.setAttribute(`gen_ai.response.finish_reasons`, [
              e.finishReason,
            ]));
          let n = h.get(e.scope);
          if ((n !== void 0 && setAgentUsage(n.step.span, e.usage), f)) {
            t.span.setAttribute(`ai.response.finish_reason`, e.finishReason);
            let n = e.content ?? [],
              r = genAiOutputMessagesAttribute(n, e.finishReason);
            r !== void 0 && t.span.setAttribute(`gen_ai.output.messages`, r);
            let i = textContentAttribute(
              n
                .filter((e) => e.type === `reasoning`)
                .map((e) => e.text)
                .filter((e) => e.trim().length > 0).join(`
`),
            );
            i !== void 0 && t.span.setAttribute(`ai.response.reasoning`, i);
            let o = textContentAttribute(
              n
                .filter((e) => e.type === `text`)
                .map((e) => e.text)
                .join(``),
            );
            o !== void 0 && t.span.setAttribute(`ai.response.text`, o);
            let c = n
              .filter((e) => e.type === `tool-call`)
              .map((e) => ({
                callId: e.callId,
                input: e.input,
                toolName: e.toolName,
              }));
            if (c.length > 0) {
              let e = contentAttribute(c, !1);
              e !== void 0 && t.span.setAttribute(`ai.response.tool_calls`, e);
            }
            let l = n
              .filter(
                (e) => e.type === `tool-result` || e.type === `tool-error`,
              )
              .map((e) =>
                e.type === `tool-result`
                  ? {
                      callId: e.callId,
                      input: e.input,
                      output: e.output,
                      toolName: e.toolName,
                    }
                  : {
                      callId: e.callId,
                      error: errorText(e.error),
                      input: e.input,
                      toolName: e.toolName,
                    },
              );
            if (l.length > 0) {
              let e = toolResultsContentAttribute(l);
              e !== void 0 &&
                t.span.setAttribute(`ai.response.tool_results`, e);
            }
          }
        }
        t.span.end();
      }
    },
    C = createAgentChannelDeliveryInstrumentation({
      ensureSessionContext: b,
      frameworkVersion: e.frameworkVersion,
      idGenerator: e.idGenerator,
      recordInputs: t,
      stateStore: e.stateStore,
      tracer: e.tracer,
    }),
    onStepMetadata = (e) => {
      let t = h.get(e.scope);
      if (t === void 0) return;
      let n = readGatewayCost(e.providerMetadata);
      if (n !== void 0)
        for (let [e, r] of Object.entries(n)) t.step.span.setAttribute(e, r);
    };
  return {
    hook: {
      capture: t || f ? `content` : `metadata`,
      events: {
        ...C,
        "action.completed": _.events[`action.completed`],
        "action.failed": _.events[`action.failed`],
        async "action.started"(e, t) {
          (await _.events[`action.started`](e, t), await y.actionStarted(e));
        },
        ...v,
        "step.attempt.completed": onStepTerminal,
        "step.attempt.failed": onStepTerminal,
        "step.attempt.metadata": onStepMetadata,
        "step.attempt.started": onStepStarted,
        "model.call.completed": onModelCallTerminal,
        "model.call.failed": onModelCallTerminal,
        "model.call.started": onModelCallStarted,
        "session.completed": onSessionTransition,
        "session.failed": onSessionTransition,
        "session.started": onSessionStarted,
        "session.waiting": onSessionTransition,
        ...y.events,
        "turn.cancelled": onTurnTerminal,
        "turn.completed": onTurnTerminal,
        "turn.failed": onTurnTerminal,
        "turn.started": onTurnStarted,
      },
      name: `eve.otel`,
    },
    prepareSessionTrace: x,
    prepareTurnTrace: S,
    runInContext(e, t) {
      let r = m.get(e.scope.attemptId) ?? e.scope,
        i = p.get(r),
        a =
          e.type === `model.call`
            ? i?.get(e.idempotencyKey)
            : y.contextFor(e.scope.attemptId, e.idempotencyKey);
      return a === void 0 ? t() : context.with(a, t);
    },
  };
  function getExecutionContexts(e) {
    let t = p.get(e);
    return (t === void 0 && ((t = new Map()), p.set(e, t)), t);
  }
  function drainOpenSpans(e) {
    for (let t of g.get(e.scope)?.values() ?? [])
      (e.type === `step.attempt.failed` && recordError(t.span, e.error),
        t.span.end());
    g.delete(e.scope);
  }
}
function getSpanStates(e, t) {
  let n = e.get(t);
  return (n === void 0 && ((n = new Map()), e.set(t, n)), n);
}
function takeSpanState(e, t, n) {
  let r = e.get(t),
    i = r?.get(n);
  if (r !== void 0) return (r.delete(n), r.size === 0 && e.delete(t), i);
}
function parentLineageAttributes(e) {
  if (e === void 0) return {};
  let t = {
    "agent.parent.call_id": e.callId,
    "agent.parent.session.id": e.sessionId,
    "agent.parent.turn.id": e.turnId,
  };
  return (
    e.subagentName !== void 0 && (t[`agent.subagent.name`] = e.subagentName),
    t
  );
}
function contextFromSpanContext(t) {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(t));
}
function readGatewayCost(e) {
  let t = e.gateway;
  if (!isRecord(t)) return;
  let n = {},
    r = readUsd(t.cost);
  r !== void 0 && (n[`gen_ai.usage.cost`] = r);
  let i = readUsd(t.gatewayCost);
  i !== void 0 && (n[`gen_ai.usage.gateway_cost`] = i);
  let a = readUsd(t.inputInferenceCost);
  a !== void 0 && (n[`gen_ai.usage.input_cost`] = a);
  let o = readUsd(t.outputInferenceCost);
  return (
    o !== void 0 && (n[`gen_ai.usage.output_cost`] = o),
    typeof t.generationId == `string` &&
      t.generationId.length > 0 &&
      (n[`gen_ai.generation.id`] = t.generationId),
    Object.keys(n).length === 0 ? void 0 : n
  );
}
function readUsd(e) {
  if (typeof e != `string`) return;
  let t = Number(e);
  return Number.isFinite(t) ? t : void 0;
}
function isRecord(e) {
  return typeof e == `object` && !!e && !Array.isArray(e);
}
function modelSpanName(e) {
  return `chat ${e}`;
}
function runtimeContextAttributes(e) {
  let t = {};
  if (e === void 0) return t;
  for (let [n, r] of Object.entries(e))
    flattenContextAttribute(t, `ai.settings.context.${n}`, r);
  return t;
}
function flattenContextAttribute(e, t, n) {
  if (n != null) {
    if (typeof n == `string` || typeof n == `number` || typeof n == `boolean`) {
      e[t] = n;
      return;
    }
    if (Array.isArray(n)) {
      let r = n.filter(
        (e) =>
          typeof e == `string` || typeof e == `number` || typeof e == `boolean`,
      );
      if (r.length !== n.length || new Set(r.map((e) => typeof e)).size !== 1)
        return;
      e[t] = r;
      return;
    }
    if (typeof n == `object`)
      for (let [r, i] of Object.entries(n))
        flattenContextAttribute(e, `${t}.${r}`, i);
  }
}
function errorText(e) {
  return e instanceof Error ? e.message : e;
}
function recordError(e, n) {
  n instanceof Error
    ? (e.recordException(n),
      e.setStatus({ code: SpanStatusCode.ERROR, message: n.message }))
    : e.setStatus({ code: SpanStatusCode.ERROR });
}
export { createAgentOtelInstrumentation };
