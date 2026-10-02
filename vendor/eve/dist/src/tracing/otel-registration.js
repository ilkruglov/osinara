import { createRequire } from "node:module";
import {
  context,
  propagation,
  trace,
} from "#compiled/@opentelemetry/api/index.js";
import { registerOTel } from "#compiled/@vercel/otel/index.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
const REGISTRATION_SPAN_NAME = `eve.otel.registration`,
  REPLAY_DEDUPLICATION_LIMIT = 1e5,
  require = createRequire(import.meta.url);
var RegistrationMarkerPropagator = class {
    #e = !1;
    extract(e) {
      return e;
    }
    fields() {
      return [];
    }
    inject() {
      this.#e = !0;
    }
    isInstalled() {
      return (
        (this.#e = !1),
        propagation.inject(context.active(), {}, { set: () => {} }),
        this.#e
      );
    }
  },
  PrivateSpanFilteringProcessor = class {
    endedSpans = new Set();
    forwardedSpans = new Set();
    pendingByParent = new Map();
    processors;
    startedSpans = new Set();
    constructor(e) {
      this.processors = e;
    }
    async forceFlush() {
      await Promise.all(this.processors.map((e) => e.forceFlush()));
    }
    onEnd(e) {
      if (isRegistrationSpan(e)) return;
      let t = spanIdentity(e);
      if (t !== void 0) {
        if (this.endedSpans.has(t)) return;
        if (this.endedSpans.size >= REPLAY_DEDUPLICATION_LIMIT) {
          let e = this.endedSpans.values().next().value;
          e !== void 0 && this.endedSpans.delete(e);
        }
        this.endedSpans.add(t);
      }
      let n = parentIdentity(e);
      if (
        n !== void 0 &&
        this.startedSpans.has(n) &&
        !this.forwardedSpans.has(n)
      ) {
        let t = this.pendingByParent.get(n) ?? [];
        (t.push(e), this.pendingByParent.set(n, t));
        return;
      }
      this.forward(e, t);
    }
    onStart(e, t) {
      if (isRegistrationSpan(e)) return;
      let n = spanIdentity(e);
      n !== void 0 && addBounded(this.startedSpans, n);
      for (let n of this.processors) n.onStart(e, t);
    }
    async shutdown() {
      await Promise.all(this.processors.map((e) => e.shutdown()));
    }
    forward(e, t) {
      for (let t of this.processors) t.onEnd(e);
      if (t === void 0) return;
      addBounded(this.forwardedSpans, t);
      let n = this.pendingByParent.get(t);
      if (n !== void 0) {
        this.pendingByParent.delete(t);
        for (let e of n) this.forward(e, spanIdentity(e));
      }
    }
  };
function registerOtelPipeline(e) {
  let { pipeline: t } = e,
    n = captureOptionalPeerTracerProxy(),
    r = new AgentSpanIdGenerator(),
    i = new RegistrationMarkerPropagator(),
    a = {
      attributes: t.resource,
      autoDetectResources: !1,
      idGenerator: r,
      instrumentations: t.instrumentations ?? [],
      propagators: [...(t.propagators ?? [`auto`]), i],
      serviceName: e.serviceName,
      spanProcessors: t.spanProcessors.map((e) =>
        isSpanProcessor(e) ? new PrivateSpanFilteringProcessor([e]) : e,
      ),
    };
  registerOTel(t.sampler === void 0 ? a : { ...a, traceSampler: t.sampler });
  let o = globalTracerUses(r),
    s = i.isInstalled();
  if (
    ((!o || !s) && rollbackRegistration({ ownsPropagator: s, ownsTracer: o }),
    !o)
  )
    throw Error(
      "eve could not register OpenTelemetry because another runtime already owns the global tracer provider. Remove the other `registerOTel` call, or move its exporters into eve's `otelIntegration({ spanProcessors: [...] })`.",
    );
  if (!s)
    throw Error(
      "eve could not register OpenTelemetry because another runtime already owns the global propagator. Remove the other global propagator registration and declare propagators through eve's `otel()` instead.",
    );
  let c = runtimeTracerProvider();
  if (typeof c.forceFlush != `function` || typeof c.shutdown != `function`)
    throw (
      rollbackRegistration({ ownsPropagator: s, ownsTracer: o }),
      Error(
        `The registered OpenTelemetry tracer provider has no lifecycle methods.`,
      )
    );
  return (
    n?.setDelegate(c),
    {
      forceFlush: () => c.forceFlush(),
      idGenerator: r,
      shutdown: () => c.shutdown(),
    }
  );
}
function captureOptionalPeerTracerProxy() {
  try {
    let e = require("@opentelemetry/api"),
      t = e.trace.getTracerProvider();
    return t instanceof e.ProxyTracerProvider ? t : void 0;
  } catch {
    return;
  }
}
function rollbackRegistration(e) {
  if ((e.ownsPropagator && propagation.disable(), !e.ownsTracer)) return;
  let t = runtimeTracerProvider();
  if (typeof t.shutdown == `function`)
    try {
      t.shutdown().catch(() => {});
    } catch {}
  trace.disable();
}
function runtimeTracerProvider() {
  let e = trace.getTracerProvider();
  return e.getDelegate?.() ?? e;
}
function globalTracerUses(e) {
  let t = e.allocateSpanId();
  return (
    e
      .withSpanId(t, () =>
        trace.getTracer(`eve.registration`).startSpan(REGISTRATION_SPAN_NAME),
      )
      .spanContext().spanId === t
  );
}
function isRegistrationSpan(e) {
  return (
    typeof e == `object` &&
    !!e &&
    `name` in e &&
    e.name === REGISTRATION_SPAN_NAME
  );
}
function spanIdentity(e) {
  if (
    typeof e != `object` ||
    !e ||
    !(`spanContext` in e) ||
    typeof e.spanContext != `function`
  )
    return;
  let t = e.spanContext();
  return typeof t.traceId == `string` && typeof t.spanId == `string`
    ? `${t.traceId}:${t.spanId}`
    : void 0;
}
function parentIdentity(e) {
  if (typeof e != `object` || !e || !(`parentSpanContext` in e)) return;
  let t = e.parentSpanContext;
  return typeof t?.traceId == `string` && typeof t.spanId == `string`
    ? `${t.traceId}:${t.spanId}`
    : void 0;
}
function addBounded(e, t) {
  if (e.size >= REPLAY_DEDUPLICATION_LIMIT) {
    let t = e.values().next().value;
    t !== void 0 && e.delete(t);
  }
  e.add(t);
}
function isSpanProcessor(e) {
  return e !== `auto`;
}
export { registerOtelPipeline };
