import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
const AgentTraceContextKey = new ContextKey(`eve.harness.agentTrace`, {
  codec: { deserialize: deserializeState, serialize: serializeState },
});
function preserveSerializedAgentTraceState(e, t) {
  let n = t[AgentTraceContextKey.name];
  return n === void 0 ? e : { ...e, [AgentTraceContextKey.name]: n };
}
function readSessionTraceContext(e, t) {
  let n = e[AgentTraceContextKey.name];
  if (n !== void 0) return deserializeState(n).sessions[t]?.context;
}
function readActionTraceContext(e, t, n, i) {
  let a = e[AgentTraceContextKey.name];
  if (a === void 0) return;
  let o = Object.values(deserializeState(a).actions).find(
    (e) => e.sessionId === t && e.turnId === n && e.callId === i,
  );
  if (o !== void 0)
    return {
      isRemote: !1,
      spanId: o.spanId,
      traceFlags: o.parent.traceFlags,
      traceId: o.parent.traceId,
    };
}
var ContextAgentTraceStateStore = class {
  deleteAction(e) {
    updateState((t) => {
      let n = { ...t.actions };
      return (delete n[e], { ...t, actions: n });
    });
  }
  deleteActions(e, t) {
    updateState((n) => {
      let r = { ...n.actions };
      for (let [n, i] of Object.entries(r))
        i.sessionId === e && (t === void 0 || i.turnId === t) && delete r[n];
      return { ...n, actions: r };
    });
  }
  deleteSession(e) {
    updateState((t) => {
      let n = { ...t.sessions };
      return (delete n[e], { ...t, sessions: n });
    });
  }
  deleteTurn(e, t) {
    updateState((n) => {
      let r = { ...n.turns };
      return (delete r[turnKey(e, t)], { ...n, turns: r });
    });
  }
  findAction(t, n) {
    return Object.values(
      contextStorage.getStore()?.get(AgentTraceContextKey)?.actions ?? {},
    ).find((e) => e.sessionId === t && e.callId === n);
  }
  getAction(t) {
    return contextStorage.getStore()?.get(AgentTraceContextKey)?.actions[t];
  }
  getSession(t) {
    return contextStorage.getStore()?.get(AgentTraceContextKey)?.sessions[t];
  }
  getTurn(t, n) {
    return contextStorage.getStore()?.get(AgentTraceContextKey)?.turns[
      turnKey(t, n)
    ];
  }
  setAction(e, t) {
    updateState((n) => ({ ...n, actions: { ...n.actions, [e]: t } }));
  }
  setSession(e, t) {
    updateState((n) => ({ ...n, sessions: { ...n.sessions, [e]: t } }));
  }
  setTurn(e, t, n) {
    updateState((r) => ({ ...r, turns: { ...r.turns, [turnKey(e, t)]: n } }));
  }
};
function updateState(e) {
  loadContext().set(AgentTraceContextKey, (t) =>
    e(t ?? { actions: {}, sessions: {}, turns: {} }),
  );
}
function turnKey(e, t) {
  return `${e}\0${t}`;
}
function serializeState(e) {
  return {
    actions: e.actions,
    sessions: Object.fromEntries(
      Object.entries(e.sessions).map(([e, t]) => [
        e,
        { ...t, context: serializeSpanContext(t.context) },
      ]),
    ),
    turns: Object.fromEntries(
      Object.entries(e.turns).map(([e, t]) => [
        e,
        {
          ...t,
          context: serializeSpanContext(t.context),
          terminal:
            t.terminal === void 0
              ? void 0
              : t.terminal.type === `turn.failed`
                ? {
                    error: serializeError(t.terminal.error),
                    type: t.terminal.type,
                  }
                : { type: t.terminal.type },
        },
      ]),
    ),
  };
}
function deserializeState(e) {
  return isRecord(e)
    ? {
        actions: deserializeRecord(e.actions, deserializeAction),
        sessions: deserializeRecord(e.sessions, (e) => {
          if (!(!isRecord(e) || !isSpanContext(e.context)))
            return {
              agentName: typeof e.agentName == `string` ? e.agentName : void 0,
              channelKind:
                typeof e.channelKind == `string` ? e.channelKind : void 0,
              context: e.context,
              rootSessionId:
                typeof e.rootSessionId == `string` ? e.rootSessionId : ``,
              turnsInWindow:
                typeof e.turnsInWindow == `number` ? e.turnsInWindow : 0,
              window: typeof e.window == `number` ? e.window : 0,
            };
        }),
        turns: deserializeRecord(e.turns, (e) => {
          if (
            !(!isRecord(e) || !isSpanContext(e.context)) &&
            !(
              typeof e.parentSpanId != `string` ||
              typeof e.startTimeMs != `number`
            )
          )
            return {
              context: e.context,
              lineage: deserializeLineage(e.lineage),
              parentIsRemote:
                typeof e.parentIsRemote == `boolean`
                  ? e.parentIsRemote
                  : void 0,
              parentSpanId: e.parentSpanId,
              rootSessionId:
                typeof e.rootSessionId == `string` ? e.rootSessionId : ``,
              sequence: typeof e.sequence == `number` ? e.sequence : 0,
              startTimeMs: e.startTimeMs,
              terminal: deserializeTerminal(e.terminal),
            };
        }),
      }
    : { actions: {}, sessions: {}, turns: {} };
}
function deserializeAction(e) {
  if (
    !(
      !isRecord(e) ||
      typeof e.attemptIndex != `number` ||
      typeof e.callId != `string` ||
      !isActionKind(e.kind) ||
      typeof e.name != `string` ||
      !isSpanContext(e.parent) ||
      typeof e.rootSessionId != `string` ||
      typeof e.sessionId != `string` ||
      typeof e.spanId != `string` ||
      typeof e.startTimeMs != `number` ||
      typeof e.stepIndex != `number` ||
      typeof e.turnId != `string`
    )
  )
    return {
      attemptIndex: e.attemptIndex,
      callId: e.callId,
      inputAttribute:
        typeof e.inputAttribute == `string` ? e.inputAttribute : void 0,
      kind: e.kind,
      name: e.name,
      parent: e.parent,
      rootSessionId: e.rootSessionId,
      sessionId: e.sessionId,
      spanId: e.spanId,
      startTimeMs: e.startTimeMs,
      stepIndex: e.stepIndex,
      turnId: e.turnId,
    };
}
function isActionKind(e) {
  return (
    e === `load-skill` ||
    e === `remote-agent-call` ||
    e === `subagent-call` ||
    e === `tool-call`
  );
}
function deserializeRecord(e, t) {
  if (!isRecord(e)) return {};
  let n = {};
  for (let [r, i] of Object.entries(e)) {
    let e = t(i);
    e !== void 0 && (n[r] = e);
  }
  return n;
}
function deserializeLineage(e) {
  if (
    !(
      !isRecord(e) ||
      typeof e.callId != `string` ||
      typeof e.sessionId != `string` ||
      typeof e.turnId != `string`
    )
  )
    return {
      callId: e.callId,
      sessionId: e.sessionId,
      subagentName: typeof e.subagentName == `string` ? e.subagentName : void 0,
      turnId: e.turnId,
    };
}
function deserializeTerminal(e) {
  if (!isRecord(e) || typeof e.type != `string`) return;
  let t = e.type;
  if (isTurnTerminalType(t))
    return t === `turn.failed`
      ? { error: deserializeError(e.error), type: t }
      : { type: t };
}
function serializeSpanContext(e) {
  return {
    isRemote: e.isRemote,
    spanId: e.spanId,
    traceFlags: e.traceFlags,
    traceId: e.traceId,
  };
}
function isSpanContext(e) {
  return (
    isRecord(e) &&
    typeof e.spanId == `string` &&
    typeof e.traceFlags == `number` &&
    typeof e.traceId == `string`
  );
}
function serializeError(e) {
  return e instanceof Error
    ? { message: e.message, name: e.name, stack: e.stack }
    : void 0;
}
function deserializeError(e) {
  if (!isRecord(e) || typeof e.message != `string`) return;
  let t = Error(e.message);
  return (
    typeof e.name == `string` && (t.name = e.name),
    typeof e.stack == `string` && (t.stack = e.stack),
    t
  );
}
function isTurnTerminalType(e) {
  return (
    e === `turn.cancelled` || e === `turn.completed` || e === `turn.failed`
  );
}
function isRecord(e) {
  return typeof e == `object` && !!e && !Array.isArray(e);
}
export {
  ContextAgentTraceStateStore,
  preserveSerializedAgentTraceState,
  readActionTraceContext,
  readSessionTraceContext,
};
