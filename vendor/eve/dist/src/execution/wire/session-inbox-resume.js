import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { isObject } from "#shared/guards.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import {
  SESSION_INBOX_WIRE_VERSION_METADATA_KEY,
  SessionInboxWireError,
  isSessionInboxWireVersion,
} from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWire } from "#execution/wire/session-inbox-encoder.js";
async function resumeSessionInbox(e, t) {
  let n = await getHookByToken(e),
    i = await resolveSessionInboxWireTarget(n);
  return await resumeHook(n, sessionInboxWire.encode(t, i));
}
async function resolveSessionInboxWireTarget(r) {
  let a = isObject(r.metadata) ? r.metadata : void 0;
  if (a !== void 0 && SESSION_INBOX_WIRE_VERSION_METADATA_KEY in a) {
    let e = a[SESSION_INBOX_WIRE_VERSION_METADATA_KEY];
    if (isSessionInboxWireVersion(e)) return { version: e };
    throw new SessionInboxWireError(
      `Session inbox target declares unsupported wire version ${JSON.stringify(e)}.`,
    );
  }
  let o = sessionCommandHookToken(r.runId);
  if (r.token === o) return { variant: `send`, version: 0 };
  try {
    let e = await getHookByToken(o);
    if (e.runId !== r.runId)
      throw new SessionInboxWireError(
        `Stable session inbox ${JSON.stringify(o)} belongs to run ${JSON.stringify(e.runId)}, expected ${JSON.stringify(r.runId)}.`,
      );
    return { variant: `send`, version: 0 };
  } catch (e) {
    if (HookNotFoundError.is(e)) return { variant: `deliver`, version: 0 };
    throw e;
  }
}
export { resolveSessionInboxWireTarget, resumeSessionInbox };
