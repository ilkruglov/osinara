import { createLogger, formatError } from "#internal/logging.js";
import { TraceFlags } from "#compiled/@opentelemetry/api/index.js";
import { JsonTraceSerializer } from "#compiled/@opentelemetry/otlp-transformer/index.js";
const VERCEL_REQUEST_CONTEXT = Symbol.for(`@vercel/request-context`),
  log = createLogger(`tracing.vercel-runtime-span-exporter`);
function vercelRuntimeSpanExporter() {
  return {
    export(e, t) {
      let n = globalThis[VERCEL_REQUEST_CONTEXT]?.get()?.telemetry;
      if (n === void 0) {
        t({ code: 0 });
        return;
      }
      try {
        let i = JsonTraceSerializer.serializeRequest([...e]);
        if (i === void 0) throw Error(`Failed to serialize spans.`);
        (n.reportSpans(JSON.parse(new TextDecoder().decode(i))),
          t({ code: 0 }));
      } catch (e) {
        t({ code: 1, error: e instanceof Error ? e : Error(String(e)) });
      }
    },
    forceFlush: async () => void 0,
    shutdown: async () => void 0,
  };
}
function vercelRuntimeSpanProcessor() {
  let e = vercelRuntimeSpanExporter(),
    n = !1;
  return {
    forceFlush: () => e.forceFlush?.() ?? Promise.resolve(),
    onEnd(r) {
      n ||
        !isSampled(r) ||
        e.export([r], (e) => {
          e.code !== 0 &&
            log.warn(`Agent Runs export failed`, {
              error: formatError(e.error ?? Error(`Span export failed.`)),
            });
        });
    },
    onStart() {},
    async shutdown() {
      ((n = !0), await e.shutdown());
    },
  };
}
function isSampled(e) {
  if (typeof e != `object` || !e || !(`spanContext` in e)) return !1;
  let t = e.spanContext;
  if (typeof t != `function`) return !1;
  let r = Reflect.apply(t, e, []);
  return (
    typeof r.traceFlags == `number` &&
    (r.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED
  );
}
export { vercelRuntimeSpanExporter, vercelRuntimeSpanProcessor };
