import { createLogger, formatError } from "#internal/logging.js";
import {
  TraceFlags,
  context,
  createContextKey,
} from "#compiled/@opentelemetry/api/index.js";
const log = createLogger(`harness.batch-span-processor`),
  SUPPRESS_TRACING_KEY = createContextKey(
    `OpenTelemetry SDK Context Key SUPPRESS_TRACING`,
  ),
  DEFAULTS = {
    exportTimeoutMillis: 3e4,
    maxExportBatchSize: 512,
    maxQueueSize: 2048,
    scheduledDelayMillis: 5e3,
  };
function batchSpanProcessor(e, n = {}) {
  let i = n.exportTimeoutMillis ?? DEFAULTS.exportTimeoutMillis,
    o = n.maxExportBatchSize ?? DEFAULTS.maxExportBatchSize,
    s = n.maxQueueSize ?? DEFAULTS.maxQueueSize,
    c = n.scheduledDelayMillis ?? DEFAULTS.scheduledDelayMillis,
    l = [],
    u,
    d = Promise.resolve(),
    f = !1;
  function cancelTimer() {
    u !== void 0 && (clearTimeout(u), (u = void 0));
  }
  function scheduleDrain() {
    u === void 0 &&
      ((u = setTimeout(() => {
        ((u = void 0), drain());
      }, c)),
      u.unref?.());
  }
  function drain() {
    return waitForExporter(pendingDrain(), `span export`).then(() => void 0);
  }
  async function exportBatch(n) {
    try {
      await new Promise((t, i) => {
        try {
          context.with(
            context.active().setValue(SUPPRESS_TRACING_KEY, !0),
            () => {
              e.export(n, (e) => {
                if (e.code === 0) {
                  t();
                  return;
                }
                i(e.error ?? Error(`Span export failed.`));
              });
            },
          );
        } catch (e) {
          i(e instanceof Error ? e : Error(String(e)));
        }
      });
    } catch (e) {
      log.warn(`span export failed`, { error: formatError(e) });
    }
  }
  return {
    async forceFlush() {
      f ||
        !(await waitForExporter(pendingDrain(), `span export`)) ||
        e.forceFlush === void 0 ||
        (await waitForExporter(
          settleExporter(`exporter flush`, e.forceFlush),
          `exporter flush`,
        ));
    },
    onEnd(e) {
      if (!f && isSampled(e) && !(l.length >= s)) {
        if ((l.push(e), l.length >= o)) {
          drain();
          return;
        }
        scheduleDrain();
      }
    },
    onStart() {},
    async shutdown() {
      f = !0;
      let t = pendingDrain();
      if (!(await waitForExporter(t, `span export`))) {
        t.then(() => settleExporter(`exporter shutdown`, e.shutdown));
        return;
      }
      await waitForExporter(
        settleExporter(`exporter shutdown`, e.shutdown),
        `exporter shutdown`,
      );
    },
  };
  function pendingDrain() {
    return (
      cancelTimer(),
      (d = d.then(async () => {
        for (; l.length > 0; ) await exportBatch(l.splice(0, o));
      })),
      d
    );
  }
  async function waitForExporter(e, t) {
    let n,
      r = new Promise((e) => {
        ((n = setTimeout(() => {
          (log.warn(`${t} timed out; preserving exporter serialization`, {
            timeoutMillis: i,
          }),
            e(!1));
        }, i)),
          n.unref?.());
      }),
      a = e.then(() => !0);
    try {
      return await Promise.race([a, r]);
    } finally {
      clearTimeout(n);
    }
  }
  async function settleExporter(n, r) {
    try {
      await r.call(e);
    } catch (e) {
      log.warn(`${n} failed`, { error: formatError(e) });
    }
  }
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
export { batchSpanProcessor };
