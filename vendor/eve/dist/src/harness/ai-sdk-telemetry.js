import { registerTelemetry } from "ai";
import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
let registered = !1;
function ensureOtelIntegration() {
  registered ||
    ((registered = !0),
    registerTelemetry(new OpenTelemetry({ runtimeContext: !0 })));
}
function getRegisteredTelemetryIntegrations() {
  return globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? [];
}
export { ensureOtelIntegration, getRegisteredTelemetryIntegrations };
