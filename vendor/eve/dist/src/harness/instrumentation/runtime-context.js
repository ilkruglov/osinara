import { createLogger, formatError } from "#internal/logging.js";
import {
  normalizeInstrumentationChannelKind,
  resolveInstrumentationProjection,
} from "#internal/instrumentation.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  ParentSessionKey,
} from "#context/keys.js";
import { parseJsonObject, parseJsonValue } from "#shared/json.js";
import { contextStorage } from "#context/container.js";
const log = createLogger(`harness.instrumentation-runtime-context`);
function buildTelemetryRuntimeContext(e) {
  let t = e.authored !== void 0,
    r = e.providerResolvers !== void 0 && e.providerResolvers.length > 0;
  if (!t && !r) return;
  let i = resolveStepStartedRuntimeContext(e),
    o = resolveProviderRuntimeContext(e),
    s = contextStorage.getStore()?.get(ChannelInstrumentationKey);
  return {
    ...i,
    ...o,
    "eve.channel.kind": normalizeInstrumentationChannelKind(s?.kind),
    "eve.environment": e.environment,
    "eve.session.id": e.session.sessionId,
    "eve.step.index": String(e.emissionState.stepIndex),
    "eve.turn.id": e.emissionState.turnId,
    "eve.turn.sequence": String(e.emissionState.sequence),
    "eve.version": e.eveVersion,
  };
}
function buildInstrumentationStepStartedInput(e) {
  let t = contextStorage.getStore(),
    r = t?.get(ChannelInstrumentationKey);
  return {
    channel: {
      kind: normalizeInstrumentationChannelKind(r?.kind),
      metadata:
        snapshotForInstrumentation(r?.metadata, `channel.metadata`) ?? {},
    },
    modelInput: snapshotForInstrumentation(e.modelInput, `modelInput`) ?? {
      instructions: void 0,
      messages: [],
    },
    session: {
      auth: projectSessionAuth(t),
      id: e.session.sessionId,
      parent: snapshotForInstrumentation(
        t?.get(ParentSessionKey),
        `session.parent`,
      ),
    },
    step: { index: e.emissionState.stepIndex },
    turn: { id: e.emissionState.turnId, sequence: e.emissionState.sequence },
  };
}
function filterAuthoredRuntimeContext(e, t) {
  let n = {};
  for (let [r, i] of Object.entries(e)) {
    if (r.startsWith(`eve.`)) {
      log.warn(`ignoring reserved instrumentation runtime context key`, {
        key: r,
        source: t,
      });
      continue;
    }
    n[r] = i;
  }
  return Object.keys(n).length > 0 ? n : void 0;
}
function resolveStepStartedRuntimeContext(e) {
  let n = e.authored?.events?.[`step.started`];
  if (n === void 0) return;
  let i = `events["step.started"]`,
    a = resolveInstrumentationProjection({
      invoke: () => {
        let t = buildInstrumentationStepStartedInput(e);
        return n(t);
      },
      log,
      source: i,
    });
  if (a === void 0) return;
  if (!(`runtimeContext` in a)) {
    log.warn(
      `ignoring instrumentation event result because runtimeContext is missing`,
      { source: i },
    );
    return;
  }
  let o;
  try {
    o = parseJsonObject(a.runtimeContext);
  } catch (e) {
    log.warn(
      `ignoring instrumentation event result because runtimeContext is invalid`,
      { error: formatError(e), source: i },
    );
    return;
  }
  return filterAuthoredRuntimeContext(o, i);
}
function resolveProviderRuntimeContext(e) {
  let t = e.providerResolvers;
  if (t === void 0 || t.length === 0) return;
  let n = {},
    i = !1;
  for (let a of t) {
    let t = `provider.runtimeContext`,
      o = resolveInstrumentationProjection({
        invoke: () => {
          let t = buildInstrumentationStepStartedInput(e);
          return a(t);
        },
        log,
        source: t,
      });
    if (o === void 0) continue;
    let s = filterAuthoredRuntimeContext(o, t);
    s !== void 0 && (Object.assign(n, s), (i = !0));
  }
  return i ? n : void 0;
}
function projectSessionAuth(e) {
  let t = e?.get(AuthKey) ?? null,
    n = e?.get(InitiatorAuthKey) ?? t;
  return {
    current: snapshotForInstrumentation(t, `session.auth.current`) ?? null,
    initiator: snapshotForInstrumentation(n, `session.auth.initiator`) ?? null,
  };
}
function snapshotForInstrumentation(e, n) {
  if (e !== void 0)
    try {
      return parseJsonValue(e);
    } catch (e) {
      log.warn(`dropping non-serializable instrumentation snapshot`, {
        error: formatError(e),
        source: n,
      });
      return;
    }
}
export { buildTelemetryRuntimeContext };
