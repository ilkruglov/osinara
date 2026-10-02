import {
  EVE_SESSION_ROUTE_PATH,
  EVE_SESSION_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
} from "#protocol/routes.js";
import { DiscoveryProjectResolutionError } from "#discover/project.js";
import { getApplicationInfo } from "#internal/application/paths.js";
import { CompileAgentError, compileAgent } from "#compiler/compile-agent.js";
async function inspectApplication(t) {
  let n = await loadCompiledApplicationState(t);
  return {
    application: getApplicationInfo(n?.project.appRoot ?? t),
    compiledState: n,
    messaging: {
      createSessionRoutePath: EVE_SESSION_ROUTE_PATH,
      sessionMessagesRoutePattern: EVE_SESSION_ROUTE_PATTERN,
      streamRoutePattern: EVE_SESSION_STREAM_ROUTE_PATTERN,
    },
  };
}
async function loadCompiledApplicationState(e) {
  try {
    return await compileAgent({ startPath: e });
  } catch (e) {
    if (e instanceof CompileAgentError) return e.result;
    if (e instanceof DiscoveryProjectResolutionError) return null;
    throw e;
  }
}
export { inspectApplication };
