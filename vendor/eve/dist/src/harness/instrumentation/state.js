import { ActiveChannelDeliveriesKey } from "#context/keys.js";
import { parseJsonValue } from "#shared/json.js";
import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
const InstrumentationStateKey = new ContextKey(
    `eve.harness.instrumentationState`,
    { codec: { deserialize: deserializeState, serialize: (e) => e } },
  ),
  InstrumentationActionScopeKey = new ContextKey(
    `eve.harness.instrumentationActionScopes`,
    { codec: { deserialize: deserializeScopes, serialize: (e) => e } },
  ),
  InstrumentationInputScopeKey = new ContextKey(
    `eve.harness.instrumentationInputScopes`,
    { codec: { deserialize: deserializeScopes, serialize: (e) => e } },
  );
function preserveSerializedInstrumentationState(t, n) {
  let r = t;
  for (let t of [
    InstrumentationStateKey,
    InstrumentationActionScopeKey,
    InstrumentationInputScopeKey,
    ActiveChannelDeliveriesKey,
  ]) {
    let e = n[t.name];
    e !== void 0 && (r = { ...r, [t.name]: e });
  }
  return r;
}
function instrumentationStateSlot(e, r, i = {}) {
  let o = stateKey(e, r),
    s = !0;
  return {
    get: () => {
      if (!s) return;
      let e = contextStorage.getStore()?.get(InstrumentationStateKey)?.[
        o
      ]?.value;
      return e === void 0 ? void 0 : cloneAndFreezeJson(e);
    },
    revoke: () => {
      s = !1;
    },
    set: (e) => {
      if (!s) return;
      let n = e === void 0 ? void 0 : cloneAndFreezeJson(parseJsonValue(e));
      writeInstrumentationState((e) => {
        if (n === void 0) return writeSlot(e, o, void 0);
        let t = e[o],
          r = { value: n };
        return (
          t?.abandoned === !0 && (r.abandoned = !0),
          assignOwner(r, i),
          writeSlot(e, o, r)
        );
      });
    },
  };
}
function abandonInstrumentationState(e, t, n = {}) {
  let r = stateKey(e, t);
  writeInstrumentationState((e) => {
    let t = e[r],
      i = {
        attemptId: n.attemptId ?? t?.attemptId,
        sessionId: n.sessionId ?? t?.sessionId,
        turnId: n.turnId ?? t?.turnId,
      },
      a = { abandoned: !0 };
    return (
      assignOwner(a, i),
      t?.value !== void 0 && (a.value = t.value),
      writeSlot(e, r, a)
    );
  });
}
function isInstrumentationStateAbandoned(e, t) {
  return (
    contextStorage.getStore()?.get(InstrumentationStateKey)?.[stateKey(e, t)]
      ?.abandoned === !0
  );
}
function releaseAllInstrumentationState(e) {
  let t = `\0${e}`;
  releaseMatchingInstrumentationState((e) => e.endsWith(t));
}
function releaseAllInstrumentationAttemptState(e) {
  releaseMatchingInstrumentationState((t, n) => n.attemptId === e);
}
function releaseAllInstrumentationTurnState(e, t) {
  releaseMatchingInstrumentationState(
    (n, r) => r.sessionId === e && (t === void 0 || r.turnId === t),
  );
}
function releaseMatchingInstrumentationState(e) {
  let t = contextStorage.getStore()?.get(InstrumentationStateKey);
  t === void 0 ||
    !Object.entries(t).some(([t, n]) => e(t, n)) ||
    writeInstrumentationState((t) => {
      let n = { ...t };
      for (let [r, i] of Object.entries(t)) e(r, i) && delete n[r];
      return n;
    });
}
function rememberInstrumentationActionScope(e, t) {
  writeContextKey(InstrumentationActionScopeKey, (n) => ({ ...n, [e]: t }));
}
function rememberInstrumentationInputScope(e, t) {
  writeContextKey(InstrumentationInputScopeKey, (n) => ({ ...n, [e]: t }));
}
function takeInstrumentationInputScope(e) {
  let t = contextStorage.getStore()?.get(InstrumentationInputScopeKey)?.[e];
  if (t !== void 0)
    return (
      writeContextKey(InstrumentationInputScopeKey, (t) => {
        let n = { ...t };
        return (delete n[e], n);
      }),
      t
    );
}
function findInstrumentationActionScopeForCall(e, t) {
  let r = contextStorage.getStore()?.get(InstrumentationActionScopeKey);
  if (r !== void 0)
    for (let n of Object.values(r)) {
      let i = `action:${e}:${n.turnId}:${t}`,
        a = r[i];
      if (a !== void 0) return { idempotencyKey: i, scope: a };
    }
}
function takeInstrumentationActionScopeForCall(e, t) {
  let n = findInstrumentationActionScopeForCall(e, t);
  if (n !== void 0)
    return (
      writeContextKey(InstrumentationActionScopeKey, (e) => {
        let t = { ...e };
        return (delete t[n.idempotencyKey], t);
      }),
      n
    );
}
function takeInstrumentationActionScopes(e, t) {
  let r = contextStorage.getStore()?.get(InstrumentationActionScopeKey);
  if (r === void 0) return [];
  let i = Object.entries(r)
    .filter(([, n]) => n.sessionId === e && (t === void 0 || n.turnId === t))
    .map(([e, t]) => ({ idempotencyKey: e, scope: t }));
  if (i.length === 0) return [];
  let a = new Set(i.map((e) => e.idempotencyKey));
  return (
    writeContextKey(InstrumentationActionScopeKey, (e) => {
      let t = { ...e };
      for (let e of a) delete t[e];
      return t;
    }),
    i
  );
}
function writeSlot(e, t, n) {
  if (n === void 0) {
    let n = { ...e };
    return (delete n[t], n);
  }
  return { ...e, [t]: n };
}
function writeInstrumentationState(e) {
  writeContextKey(InstrumentationStateKey, e);
}
function assignOwner(e, t) {
  (t.attemptId !== void 0 && (e.attemptId = t.attemptId),
    t.sessionId !== void 0 && (e.sessionId = t.sessionId),
    t.turnId !== void 0 && (e.turnId = t.turnId));
}
function writeContextKey(e, t) {
  contextStorage.getStore() !== void 0 &&
    loadContext().set(e, (e) => t(e ?? {}));
}
function stateKey(e, t) {
  return `${e}\0${t}`;
}
function deserializeState(e) {
  if (typeof e != `object` || !e || Array.isArray(e)) return {};
  let t = {};
  for (let [n, r] of Object.entries(e)) {
    if (typeof r != `object` || !r || Array.isArray(r)) continue;
    let e = r,
      i = typeof e.attemptId == `string` ? e.attemptId : void 0,
      a = typeof e.sessionId == `string` ? e.sessionId : void 0,
      o = typeof e.turnId == `string` ? e.turnId : void 0,
      s = {};
    (e.abandoned === !0 && (s.abandoned = !0),
      i !== void 0 && (s.attemptId = i),
      a !== void 0 && (s.sessionId = a),
      o !== void 0 && (s.turnId = o),
      e.value !== void 0 && (s.value = cloneAndFreezeJson(e.value)),
      (t[n] = s));
  }
  return t;
}
function cloneAndFreezeJson(e) {
  if (Array.isArray(e))
    return Object.freeze(e.map((e) => cloneAndFreezeJson(e)));
  if (typeof e != `object` || !e) return e;
  let t = {};
  for (let [n, r] of Object.entries(e)) t[n] = cloneAndFreezeJson(r);
  return Object.freeze(t);
}
function deserializeScopes(e) {
  return typeof e != `object` || !e || Array.isArray(e) ? {} : e;
}
export {
  abandonInstrumentationState,
  findInstrumentationActionScopeForCall,
  instrumentationStateSlot,
  isInstrumentationStateAbandoned,
  preserveSerializedInstrumentationState,
  releaseAllInstrumentationAttemptState,
  releaseAllInstrumentationState,
  releaseAllInstrumentationTurnState,
  rememberInstrumentationActionScope,
  rememberInstrumentationInputScope,
  takeInstrumentationActionScopeForCall,
  takeInstrumentationActionScopes,
  takeInstrumentationInputScope,
};
