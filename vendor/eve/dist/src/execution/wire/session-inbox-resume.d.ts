import type { DeliverHookPayload, SessionCommand, SessionTimeoutHookPayload } from "#channel/types.js";
import { type SessionInboxWireTarget } from "#execution/wire/session-inbox-contract.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
type ResumedSessionInboxHook = Awaited<ReturnType<typeof resumeHook>>;
/** Resolves the consumer contract, encodes for it, and resumes that exact hook. */
export declare function resumeSessionInbox(token: string, command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload): Promise<ResumedSessionInboxHook>;
type SessionInboxHook = Awaited<ReturnType<typeof getHookByToken>>;
/** Selects the encoder understood by a persisted hook's consumer deployment. */
export declare function resolveSessionInboxWireTarget(hook: SessionInboxHook): Promise<SessionInboxWireTarget>;
export {};
