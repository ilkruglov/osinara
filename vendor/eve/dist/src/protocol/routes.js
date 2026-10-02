const EVE_ROUTE_PREFIX = `/eve/v1`,
  EVE_HEALTH_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/health`,
  EVE_INFO_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/info`,
  EVE_SESSION_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/session`,
  EVE_SESSION_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId`,
  EVE_SESSION_CANCEL_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/cancel`,
  EVE_SESSION_COMPACT_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/compact`,
  EVE_SESSION_CLEAR_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/clear`,
  EVE_SESSION_RESET_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/reset`,
  EVE_SESSION_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/stream`,
  EVE_SUBAGENT_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:parentSessionId/subagents/:callId/:childSessionId/stream`,
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/dev/schedules/:scheduleId`,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/dev/runtime-artifacts`,
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/rebuild`,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/suspend`,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/resume`;
function createEveDevDispatchSchedulePath(t) {
  return `${EVE_ROUTE_PREFIX}/dev/schedules/${encodeURIComponent(t)}`;
}
const EVE_CONNECTION_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/connections/:name/callback/:attemptId/:token`,
  EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/connections/:name/callback/:token`,
  EVE_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/callback/:token`,
  EVE_TASK_INPUT_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/task-input/:token`;
function createEveSessionRoutePath(e) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e)}`;
}
function createEveSessionCancelRoutePath(e) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e)}/cancel`;
}
function createEveSubagentStreamRoutePath(e) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e.parentSessionId)}/subagents/${encodeURIComponent(e.callId)}/${encodeURIComponent(e.childSessionId)}/stream`;
}
function createEveSessionCompactRoutePath(e) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e)}/compact`;
}
function createEveSessionClearRoutePath(e) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e)}/clear`;
}
function createEveSessionResetRoutePath(e) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e)}/reset`;
}
function createEveSessionStreamRoutePath(e) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(e)}/stream`;
}
function createEveConnectionCallbackRoutePath(t, n, r) {
  return `${EVE_ROUTE_PREFIX}/connections/${encodeURIComponent(t)}/callback/${encodeURIComponent(n)}/${encodeURIComponent(r)}`;
}
function createEveCallbackRoutePath(t) {
  return `${EVE_ROUTE_PREFIX}/callback/${encodeURIComponent(t)}`;
}
function createEveTaskInputRoutePath(t) {
  return `${EVE_ROUTE_PREFIX}/task-input/${encodeURIComponent(t)}`;
}
export {
  EVE_CALLBACK_ROUTE_PATTERN,
  EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
  EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN,
  EVE_ROUTE_PREFIX,
  EVE_SESSION_CANCEL_ROUTE_PATTERN,
  EVE_SESSION_CLEAR_ROUTE_PATTERN,
  EVE_SESSION_COMPACT_ROUTE_PATTERN,
  EVE_SESSION_RESET_ROUTE_PATTERN,
  EVE_SESSION_ROUTE_PATH,
  EVE_SESSION_ROUTE_PATTERN,
  EVE_SESSION_STREAM_ROUTE_PATTERN,
  EVE_SUBAGENT_STREAM_ROUTE_PATTERN,
  EVE_TASK_INPUT_ROUTE_PATTERN,
  createEveCallbackRoutePath,
  createEveConnectionCallbackRoutePath,
  createEveDevDispatchSchedulePath,
  createEveSessionCancelRoutePath,
  createEveSessionClearRoutePath,
  createEveSessionCompactRoutePath,
  createEveSessionResetRoutePath,
  createEveSessionRoutePath,
  createEveSessionStreamRoutePath,
  createEveSubagentStreamRoutePath,
  createEveTaskInputRoutePath,
};
