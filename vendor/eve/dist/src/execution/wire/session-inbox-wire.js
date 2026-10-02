import {
  SESSION_INBOX_WIRE_VERSION,
  SessionInboxWireError,
  SessionInboxWireError as SessionInboxWireError$1,
} from "#execution/wire/session-inbox-contract.js";
import { sessionInboxWireV0Migration } from "#execution/wire/session-inbox-wire.v0.js";
import { runMigrationChain } from "#execution/durable-session-migrations/chain.js";
const WIRE_LABEL = `session inbox payload`,
  sessionInboxMigrations = [sessionInboxWireV0Migration];
function decode(t) {
  let n;
  try {
    n = runMigrationChain({
      initialVersion: 0,
      label: WIRE_LABEL,
      migrations: sessionInboxMigrations,
      targetVersion: SESSION_INBOX_WIRE_VERSION,
      value: t,
    });
  } catch (e) {
    throw new SessionInboxWireError$1(
      e instanceof Error ? e.message : String(e),
    );
  }
  let r = n;
  if (r.version !== SESSION_INBOX_WIRE_VERSION)
    throw new SessionInboxWireError$1(
      `${WIRE_LABEL} declares version ${JSON.stringify(r.version)}, expected ${SESSION_INBOX_WIRE_VERSION}.`,
    );
  return normalizeWire(r);
}
const sessionInboxWire = { decode };
function normalizeWire(e) {
  switch (e.kind) {
    case `deliver`:
      return {
        auth: e.auth,
        caller: e.caller,
        deliveryMetadata: e.deliveryMetadata,
        kind: `deliver`,
        payloads: e.payloads,
        requestId: e.requestId,
        taskDeliveryId: e.taskDeliveryId,
        turnPolicy: e.turnPolicy,
      };
    case `session-timeout`:
      return { kind: `session-timeout` };
    case `clear`:
      return { kind: `clear` };
    case `compact`:
      return { kind: `compact` };
    case `reset`:
      return { kind: `reset`, reason: e.reason };
    case `cancel`:
      return { kind: `cancel`, taskId: e.taskId, turnId: e.turnId };
    default:
      throw new SessionInboxWireError$1(
        `${WIRE_LABEL} has an unrecognized kind ${JSON.stringify(e.kind)}.`,
      );
  }
}
export { SessionInboxWireError, sessionInboxWire };
