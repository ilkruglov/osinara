function readTaskUsage(e) {
  if (typeof e != `object` || !e || Array.isArray(e)) return;
  let t = readUsageAxis(e, `cacheReadTokens`),
    n = readUsageAxis(e, `cacheWriteTokens`),
    r = readUsageAxis(e, `inputTokens`),
    i = readUsageAxis(e, `outputTokens`);
  if (!(t === void 0 || n === void 0 || r === void 0 || i === void 0))
    return {
      cacheReadTokens: t,
      cacheWriteTokens: n,
      inputTokens: r,
      outputTokens: i,
    };
}
function readUsageAxis(e, t) {
  let n = Reflect.get(e, t);
  return typeof n == `number` && Number.isFinite(n) && n >= 0 ? n : void 0;
}
const TASK_AUTHORIZATION_REQUEST_ID_PREFIX = `task:authorization`;
function taskAuthorizationRequestId(t) {
  return t.type === `approval.candidate` || t.type === `approval.settled`
    ? `${TASK_AUTHORIZATION_REQUEST_ID_PREFIX}:${t.data.requestId}`
    : `${TASK_AUTHORIZATION_REQUEST_ID_PREFIX}:${t.data.attemptId ?? t.data.name}`;
}
function readTaskInputRequestId(e) {
  if (typeof e != `object` || !e || Array.isArray(e)) return;
  let t = Reflect.get(e, `requestId`);
  return typeof t == `string` ? t : void 0;
}
const TASK_VIEW_STREAM_NAMESPACE = `eve.task`;
function isTerminalTaskStatus(e) {
  return e === `completed` || e === `failed` || e === `cancelled`;
}
function isReadyTaskStatus(e) {
  return e === `input_required` || isTerminalTaskStatus(e);
}
export {
  TASK_VIEW_STREAM_NAMESPACE,
  isReadyTaskStatus,
  isTerminalTaskStatus,
  readTaskInputRequestId,
  readTaskUsage,
  taskAuthorizationRequestId,
};
