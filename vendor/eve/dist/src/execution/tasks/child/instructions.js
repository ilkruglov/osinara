import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";
const TASK_UPDATE_SESSION_INSTRUCTION =
  "Background task updates\nYou are running as a background task. For multi-step work, use `task_update` at meaningful milestones to briefly state what you are currently doing. Keep updates terse and activity-focused; do not include preliminary findings or results. Do not wait for a response, and return your final result normally.";
function isTaskOwnedSerializedContext(e) {
  let t = e[`eve.sessionCallback`];
  if (typeof t == `object` && t && typeof Reflect.get(t, `taskId`) == `string`)
    return !0;
  let n = e[`eve.channel`];
  if (typeof n != `object` || !n) return !1;
  let r = Reflect.get(n, `state`);
  if (typeof r != `object` || !r) return !1;
  let i = Reflect.get(r, `parentContinuationToken`);
  return typeof i == `string` && readTaskIdFromInboxToken(i) !== void 0;
}
export { TASK_UPDATE_SESSION_INSTRUCTION, isTaskOwnedSerializedContext };
