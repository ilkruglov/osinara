import {
  ContinuationTokenKey,
  SessionCallbackKey,
  SessionIdKey,
} from "#context/keys.js";
import { fireTaskEventCallbackStep } from "#execution/session-callback-step.js";
async function forwardTaskEventToSessionCallback(e, t) {
  let n = e.get(SessionCallbackKey);
  return n?.taskId === void 0 ||
    (t.type !== `input.requested` &&
      t.type !== `authorization.required` &&
      t.type !== `authorization.completed`)
    ? !1
    : (await fireTaskEventCallbackStep({
        callback: n,
        childContinuationToken: e.require(ContinuationTokenKey),
        childSessionId: e.require(SessionIdKey),
        event: t,
      }),
      !0);
}
export { forwardTaskEventToSessionCallback };
