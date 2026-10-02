import { createLogger, logError } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { deserializeContext } from "#context/serialize.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";
const log = createLogger(`execution.terminate-child-sessions`);
async function terminateChildSessionsStep(e) {
  "use step";
  let s;
  try {
    s = await readDurableSession(e.sessionState);
  } catch (n) {
    logError(log, `failed to read child sessions for termination`, n, {
      parentSessionId: e.sessionState.sessionId,
    });
    return;
  }
  let c = readSessionTaskIndex(s.state, s.sessionId);
  if (c.length > 0) {
    if (e.serializedContext === void 0)
      throw Error(`Task finalization requires serialized runtime context.`);
    let r = await deserializeContext(e.serializedContext),
      i = r.require(BundleKey),
      a = resolveEffectiveAgentRuntime(i, r),
      o = hydrateDurableSession({ durable: s, turnAgent: a.turnAgent });
    for (let e of c)
      try {
        await cancelOwnedTask({ bundle: i, entry: e, session: o });
      } catch (n) {
        logError(log, `failed to cancel task during parent finalization`, n, {
          parentSessionId: s.sessionId,
          taskId: e.taskId,
        });
      }
  }
  let l = (getAgentHandleStore(s.state)?.handles ?? []).filter(
    isLocalChildHandle,
  );
  if (l.length !== 0)
    for (let e of l) {
      if (e.phase === `starting`) {
        log.debug(`skipping starting child without a session id`, {
          agentId: e.identity.id,
          kind: e.target.kind,
          parentSessionId: s.sessionId,
        });
        continue;
      }
      try {
        await cancelRun(await getWorld(), e.address.sessionId, {
          cancelReason: `Parent session ended`,
        });
      } catch (n) {
        logError(log, `failed to terminate child session`, n, {
          agentId: e.identity.id,
          childSessionId: e.address.sessionId,
          kind: e.address.kind,
          parentSessionId: s.sessionId,
        });
      }
    }
}
function isLocalChildHandle(e) {
  let t = e.phase === `starting` ? e.target.kind : e.address.kind;
  return t === `agent/local` || t === `agent/self`;
}
function readSessionTaskIndex(e, n) {
  try {
    return getSessionTaskIndex(e);
  } catch (e) {
    return (
      logError(
        log,
        `failed to read the task index during parent finalization`,
        e,
        { parentSessionId: n },
      ),
      []
    );
  }
}
export { terminateChildSessionsStep };
