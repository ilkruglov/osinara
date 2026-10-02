/** Every explicit session-inbox wire version still supported by producers. */
export declare const SESSION_INBOX_WIRE_VERSIONS: readonly [1];
export type SessionInboxWireVersion = (typeof SESSION_INBOX_WIRE_VERSIONS)[number];
/** Current persisted session-inbox wire version. */
export declare const SESSION_INBOX_WIRE_VERSION: 1;
/** Hook metadata field advertising the consumer's inbox wire capability. */
export declare const SESSION_INBOX_WIRE_VERSION_METADATA_KEY = "sessionInboxWireVersion";
/**
 * The consumer wire selected before a producer persists a payload.
 *
 * Version 0 had two incompatible unversioned shapes, so its historical
 * variants remain explicit rather than pretending they were one protocol.
 */
export type SessionInboxWireTarget = {
    readonly variant: "deliver" | "send";
    readonly version: 0;
} | {
    readonly version: SessionInboxWireVersion;
};
export declare function isSessionInboxWireVersion(value: unknown): value is SessionInboxWireVersion;
/** Raised when a session inbox value violates its versioned wire contract. */
export declare class SessionInboxWireError extends Error {
    constructor(message: string);
}
