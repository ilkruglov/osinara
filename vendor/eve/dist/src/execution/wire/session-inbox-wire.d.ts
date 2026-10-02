import type { DeliverHookPayload, SessionCommand, SessionTimeoutHookPayload } from "#channel/types.js";
/**
 * The session inbox wire family: every payload persisted to a session's
 * durable inbox hooks crosses through `sessionInboxWire.encode` /
 * `sessionInboxWire.decode`.
 *
 * Historic migrations live in `session-inbox-wire.vN.ts` modules; the
 * current schema and encoder live in the current version module. This file
 * remains the dependency-free decoder facade reached by the workflow body.
 *
 * See research/session-inbox-wire-schema.md and issue #1765.
 */
/** A persisted inbox payload normalized for consumption; `send` never survives decode. */
export type DecodedSessionInbox = DeliverHookPayload | SessionTimeoutHookPayload | Extract<SessionCommand, {
    readonly kind: "cancel" | "clear" | "compact" | "reset";
}>;
export { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
/**
 * Decodes a persisted inbox payload or throws {@link SessionInboxWireError}.
 *
 * Unknown newer versions and shape mismatches both throw: a lost delivery
 * with an operator-visible signal is the designed failure; a reinterpreted
 * delivery is the bug this module exists to prevent.
 */
declare function decode(value: unknown): DecodedSessionInbox;
/** Workflow-safe consumer facade. */
export declare const sessionInboxWire: {
    readonly decode: typeof decode;
};
