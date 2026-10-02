import type { SandboxSession } from "#shared/sandbox-session.js";
/**
 * Returns a sandbox session that applies `abortSignal` to every operation.
 * Per-call signals are composed with the bound signal.
 */
export declare function bindSandboxAbortSignal<TSession extends SandboxSession>(session: TSession, abortSignal: AbortSignal): TSession;
