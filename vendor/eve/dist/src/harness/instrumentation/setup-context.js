import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  isEveDevEnvironment,
  resolveEveEvaluationRunId,
} from "#internal/application/dev-environment.js";
function createInstrumentationSetupContext(e) {
  let t = resolveEveEvaluationRunId();
  return {
    agentName: e,
    environment: resolveInstrumentationEnvironment(),
    evaluation: t === void 0 ? void 0 : { runId: t },
    frameworkVersion: resolveInstalledPackageInfo().version,
  };
}
function resolveInstrumentationEnvironment() {
  return isEveDevEnvironment() || process.env.VERCEL_ENV === `development`
    ? `development`
    : process.env.VERCEL_ENV === `preview`
      ? `preview`
      : `production`;
}
export { createInstrumentationSetupContext };
