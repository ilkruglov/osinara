import { getInstrumentationRuntime } from "#harness/instrumentation/runtime.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import {
  collectOtelPipeline,
  otel,
  otelIntegration,
} from "#tracing/otel-declaration.js";
import {
  createLocalTracesProcessor,
  resolveLocalTracesContent,
} from "#tracing/local-traces.js";
function installLocalInstrumentationRuntime(e) {
  let t = getInstrumentationRuntime();
  if (t !== void 0) return t;
  let n = createLocalTracesProcessor({ appRoot: e.appRoot });
  return installInstrumentationRuntime({
    collected: collectOtelPipeline([
      otel(),
      otelIntegration({ ...resolveLocalTracesContent(), spanProcessors: [n] }),
    ]),
    frameworkVersion: e.frameworkVersion,
    providers: [],
    serviceName: e.serviceName,
  });
}
export { installLocalInstrumentationRuntime };
