import type { DeliverHookPayload, SessionCommand, SessionTimeoutHookPayload } from "#channel/types.js";
import { type SessionInboxWireV1 } from "#execution/wire/session-inbox-wire.v1.js";
import { type SessionInboxWireTarget, type SessionInboxWireVersion } from "#execution/wire/session-inbox-contract.js";
type SessionInboxCommand = DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload;
/** Current wire type consumed after migration. */
export type SessionInboxWire = SessionInboxWireV1;
type LegacySessionInboxWireTarget = Extract<SessionInboxWireTarget, {
    readonly version: 0;
}>;
/** Encodes a command for the selected session-inbox consumer. */
declare function encode(command: SessionInboxCommand, target: {
    readonly version: 1;
}): SessionInboxWireV1;
declare function encode(command: SessionInboxCommand, target: {
    readonly version: SessionInboxWireVersion;
}): unknown;
declare function encode(command: SessionInboxCommand, target: LegacySessionInboxWireTarget): Record<string, unknown>;
declare function encode(command: SessionInboxCommand, target: SessionInboxWireTarget): SessionInboxWireV1 | Record<string, unknown>;
/** Server/step-safe producer facade. */
export declare const sessionInboxWire: {
    readonly encode: typeof encode;
};
export {};
