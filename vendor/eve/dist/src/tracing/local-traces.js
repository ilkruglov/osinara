import { LocalTraceSpanProcessor } from "#tracing/local-trace-span-processor.js";
import { AgentTraceSpanProcessor } from "#tracing/agent-trace-span-processor.js";
import {
  requestLocalTraceStorePrune,
  resolveLocalTraceRetentionSettings,
} from "#tracing/local-trace-retention.js";
function hasSessionRelease(e) {
  return typeof e.releaseSession == `function`;
}
function createLocalTracesProcessor(r = {}) {
  let i = r.appRoot ?? process.env.EVE_DEV_WORKER_APP_ROOT;
  if (i === void 0) return inertLocalTracesProcessor();
  let a = resolveLocalTraceRetentionSettings(),
    o = new AgentTraceSpanProcessor(
      a.enabled ? [new LocalTraceSpanProcessor(i)] : [],
    ),
    requestPrune = () => {
      a.enabled &&
        requestLocalTraceStorePrune({
          activeTraceIds: o.activeTraceIds(),
          appRoot: i,
          maxAgeMs: a.maxAgeMs,
          maxTotalBytes: a.maxTotalBytes,
          retainCount: a.retainCount,
        });
    };
  return (
    requestPrune(),
    {
      forceFlush: () => o.forceFlush(),
      onEnd: (e) => o.onEnd(e),
      onStart: (e, t) => o.onStart(e, t),
      async releaseSession(e) {
        return (
          await o.forceFlush(),
          o.releaseSession(e) ? (requestPrune(), !0) : !1
        );
      },
      shutdown: () => o.shutdown(),
    }
  );
}
function resolveLocalTracesContent(e = {}) {
  let t = process.env.EVE_TRACES_CONTENT === `on`,
    n = process.env.EVE_TRACES_CONTENT !== `off`;
  return {
    recordInputs: n && (e.recordInputs ?? t),
    recordOutputs: n && (e.recordOutputs ?? t),
  };
}
function inertLocalTracesProcessor() {
  return {
    forceFlush: async () => void 0,
    onEnd: () => void 0,
    onStart: () => void 0,
    releaseSession: async () => !1,
    shutdown: async () => void 0,
  };
}
export {
  createLocalTracesProcessor,
  hasSessionRelease,
  resolveLocalTracesContent,
};
