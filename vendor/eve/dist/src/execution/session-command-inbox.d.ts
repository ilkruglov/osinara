import type { DeliverHookPayload, RuntimeActionResultHookPayload, SessionCommand, SessionTimeoutHookPayload } from "#channel/types.js";
/**
 * Payloads accepted by a session driver's stable and channel aliases.
 *
 * This union is the hook's transport typing only; consumers interpret every
 * payload through `sessionInboxWire.decode` in `execution/wire/session-inbox-wire.ts`,
 * which owns the versioned wire schema and its legacy-shape fallbacks.
 */
export type SessionInboxPayload = DeliverHookPayload | RuntimeActionResultHookPayload | SessionCommand | SessionTimeoutHookPayload;
/** Which hook family produced an inbox read. */
export type SessionInboxSource = "authorization" | "session";
/**
 * Multiplexes one stable session hook, one rekeyable channel alias, and one
 * window-gated authorization-callback hook.
 */
export interface SessionCommandInbox {
    /**
     * Claims the session's authorization-callback hook as an inbox source.
     * Its reads stay stashed until {@link setAuthorizationWindow} opens, so
     * callbacks never surface as ordinary session activity.
     */
    claimAuthorization(token: string): Promise<void>;
    claimStable(token: string): Promise<void>;
    consumeNext(): void;
    /** Whether an authorization read is already eligible to be consumed. */
    hasReadyAuthorization(): boolean;
    next(): Promise<IteratorResult<SessionInboxPayload>>;
    /**
     * Like {@link next} but reports which hook family produced the read.
     * Reads surface in one arrival order across every source, which keeps
     * waits that interleave authorization callbacks with ordinary session
     * activity deterministic under workflow replay.
     */
    nextWithSource(): Promise<{
        result: IteratorResult<SessionInboxPayload>;
        source: SessionInboxSource;
    }>;
    rekeyContinuation(token: string): Promise<void>;
    /** Opens or closes the surfacing window for authorization-callback reads. */
    setAuthorizationWindow(open: boolean): void;
}
/** Adds workflow-entry lifecycle ownership to a session command inbox. */
export interface SessionCommandInboxHandle extends SessionCommandInbox {
    dispose(): Promise<void>;
}
/**
 * Creates the command inbox owned by one session driver.
 *
 * The stable hook is retained for the session's lifetime. Rekeying replaces
 * only the channel alias. Reads already committed to a retired alias remain in
 * the multiplexed queue and are consumed exactly once.
 */
export declare function createSessionCommandInbox(): SessionCommandInboxHandle;
