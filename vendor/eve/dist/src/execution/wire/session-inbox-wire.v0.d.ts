import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import type { SessionInboxWireV1 } from "#execution/wire/session-inbox-wire.v1.js";
export declare const sessionInboxWireV0Migration: VersionMigration;
/** Encodes the two incompatible shapes from the unversioned wire era. */
export declare function encodeSessionCommandV0(wire: SessionInboxWireV1, variant: "deliver" | "send"): Omit<SessionInboxWireV1, "version"> | Record<string, unknown>;
