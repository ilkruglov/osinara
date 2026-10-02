import { registerInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { createInstrumentationHooks } from "#harness/instrumentation/lifecycle.js";
import { createInstrumentationSetupContext } from "#harness/instrumentation/setup-context.js";
const INSTRUMENTATION_CONFIG_GLOBAL_KEY = Symbol.for(
    `eve.harness-instrumentation-config`,
  ),
  globalContainer = globalThis;
async function registerInstrumentationConfig(n, r) {
  ((globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY] = n),
    registerInstrumentationRuntime({
      forceFlush: async () => void 0,
      hooks: createInstrumentationHooks([]),
      otelSettings: {
        functionId: n.functionId,
        recordInputs: n.recordInputs === !0,
        recordOutputs: n.recordOutputs === !0,
        traceChannelRequests: n.traceChannelRequests === !0,
      },
      runInContext: (e, t) => t(),
      shutdown: async () => void 0,
    }),
    await n.setup?.(createInstrumentationSetupContext(r.agentName)));
}
function getInstrumentationConfig() {
  return globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY];
}
export { getInstrumentationConfig, registerInstrumentationConfig };
