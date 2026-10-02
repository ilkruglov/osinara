/**
 * Authorization request/result API for tool execution.
 *
 * Public API:
 * - {@link requestAuthorization} — return from execute to suspend for auth
 * - {@link getAuthorizationResult} — read the callback on resume
 * - {@link createAuthorizationAttempt} — mint one correlated callback URL
 * - {@link isAuthorizationSignal} — type guard
 *
 * ## Resume lifecycle
 *
 * `attemptId` binds the callback to one challenge generation, while `resume`
 * carries strategy data from
 * `startAuthorization` to `completeAuthorization` across the park:
 *
 * 1. `startAuthorization` returns `{ challenge, resume? }`. The runtime
 *    stores `resume` on the {@link AuthorizationChallenge} and journals it
 *    onto `session.state` via {@link setPendingAuthorization} when the turn
 *    parks — so it survives the suspend/resume across a `"use step"`
 *    boundary.
 * 2. The IdP redirect hits the framework callback route, which parses it
 *    (see `projectAuthorizationCallback` — params only, no headers) and
 *    resumes the workflow.
 * 3. On resume the journaled `resume` is paired with the parsed callback
 *    into an {@link AuthorizationResult} and handed back to
 *    `completeAuthorization({ resume, callback })`.
 *
 * `resume` is serialized across workflow steps to survive the park.
 * Provider-owned strategies (Vercel Connect) omit it so nothing crosses
 * the boundary; a custom PKCE strategy uses it to carry the verifier (or a
 * nonce that re-derives it) from start to finish.
 */
import { ContextKey } from "#context/key.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { AuthorizationCallback, ConnectionPrincipal } from "#runtime/connections/types.js";
import type { JsonValue } from "#public/types/json.js";
declare const AUTHORIZATION_BRAND: "__eveAuthorization";
declare const AUTHORIZATION_PENDING_BRAND: "__eveAuthorizationPending";
export interface AuthorizationChallenge {
    /** Opaque identity of this exact authorization attempt. */
    readonly attemptId?: string;
    readonly candidateId?: string;
    readonly name: string;
    readonly challenge: ConnectionAuthorizationChallenge;
    readonly hookUrl: string;
    /** Principal passed to `startAuthorization`; omitted from model-facing copies. */
    readonly principal?: ConnectionPrincipal;
    /**
     * Opaque resume value from the strategy's `startAuthorization`,
     * journaled across the park. Absent for provider-owned flows.
     */
    readonly resume?: JsonValue;
}
export interface AuthorizationSignal {
    readonly [AUTHORIZATION_BRAND]: true;
    readonly challenges: readonly AuthorizationChallenge[];
}
/**
 * Opaque tool output the model sees while authorization is pending.
 * Contains connection names only — no OAuth URLs, user codes, or hook URLs.
 */
export interface AuthorizationPendingModelOutput {
    readonly [AUTHORIZATION_PENDING_BRAND]: true;
    readonly connections: readonly string[];
}
export interface AuthorizationResult {
    readonly attemptId?: string;
    readonly resume?: JsonValue;
    readonly callback: AuthorizationCallback;
    readonly hookUrl: string;
    readonly principal?: ConnectionPrincipal;
}
/**
 * Creates an authorization signal. Return this from a tool's execute
 * to suspend the session for OAuth or other external authorization.
 *
 * The harness emits `authorization.required` events for each challenge
 * and parks the session. Channels render sign-in buttons.
 */
export declare function requestAuthorization(challenges: readonly AuthorizationChallenge[]): AuthorizationSignal;
/**
 * Returns a copy of `signal` with each challenge's `resume` value stripped.
 *
 * Used for the copy the AI SDK records as a tool output. The shape stays a
 * valid {@link AuthorizationSignal} so every `isAuthorizationSignal` consumer
 * still detects it; the park detector reads the full challenges from the
 * harness's out-of-band stash.
 */
export declare function redactSignalResume(signal: AuthorizationSignal): AuthorizationSignal;
/**
 * Reads the authorization callback on resume. Returns `undefined` if
 * not resuming from an authorization request.
 *
 * When `name` is omitted, returns the first result (convenience for
 * single-challenge tools).
 */
export declare function getAuthorizationResult(name?: string): AuthorizationResult | undefined;
/**
 * Removes and returns one authorization callback result.
 *
 * Callback results are one-shot inputs to `completeAuthorization`. Consuming
 * before completion prevents a failed or replayed callback from poisoning
 * every later tool call in the same step.
 */
export declare function consumeAuthorizationResult(name: string): AuthorizationResult | undefined;
/**
 * Builds a callback URL for external systems. `name` and `attemptId` identify
 * the exact challenge in the URL path.
 *
 * The URL embeds the session's authorization hook token (`${sessionId}:auth`).
 * It is independent of the continuation token, so channel re-keying mid-turn
 * does not invalidate the callback URL.
 *
 * Returns `undefined` if the session context isn't available.
 */
export declare function getHookUrl(name: string, attemptId: string): string | undefined;
/** Mints the identity and callback URL for one interactive authorization attempt. */
export declare function createAuthorizationAttempt(name: string): {
    readonly attemptId: string;
    readonly hookUrl: string;
} | undefined;
export declare function isAuthorizationSignal(value: unknown): value is AuthorizationSignal;
export declare function isAuthorizationPendingModelOutput(value: unknown): value is AuthorizationPendingModelOutput;
/**
 * JSON-safe pending authorization output for model-facing tool results and
 * wire surfaces (`action.result`, telemetry). Omits OAuth URLs and user
 * codes — connection names only.
 */
export declare function authorizationPendingAsJsonObject(input: {
    readonly connections: readonly string[];
}): AuthorizationPendingModelOutput;
/**
 * Projects a full {@link AuthorizationSignal} to the opaque shape recorded
 * in model-facing tool results and session history.
 */
export declare function modelFacingAuthorizationOutput(signal: AuthorizationSignal): AuthorizationPendingModelOutput;
/** Human-readable tool output for {@link modelFacingAuthorizationOutput}. */
export declare function authorizationPendingModelText(connections: readonly string[]): string;
export declare function isPendingAuthorizationToolOutput(value: unknown): boolean;
/**
 * Deterministic hook token for all authorization callbacks in a
 * session. Both {@link getHookUrl} (inside tool execution) and the
 * workflow body (which creates the hook upfront) use this token.
 */
export declare function authHookToken(sessionId: string): string;
interface NamedAuthorizationResult extends AuthorizationResult {
    readonly name: string;
}
export declare const PendingAuthorizationResultKey: ContextKey<readonly NamedAuthorizationResult[]>;
/**
 * Deployment base URL for building callback URLs. Set by the
 * framework (turnStep) at the start of each step from workflow
 * metadata.
 */
export declare const CallbackBaseUrlKey: ContextKey<string>;
export interface PendingAuthorizationState {
    readonly challenges: readonly AuthorizationChallenge[];
}
export declare function setPendingAuthorization(sessionState: Record<string, unknown> | undefined, value: PendingAuthorizationState): Record<string, unknown>;
/** Existing same-scope attempts replaced by newer attempts for the same principal. */
export declare function getSupersededAuthorizationChallenges(sessionState: Record<string, unknown> | undefined, replacements: readonly AuthorizationChallenge[]): readonly AuthorizationChallenge[];
export declare function clearPendingAuthorization(sessionState: Record<string, unknown> | undefined, attemptIds?: readonly string[]): Record<string, unknown> | undefined;
export declare function getPendingAuthorization(sessionState: Record<string, unknown> | undefined): PendingAuthorizationState | undefined;
export declare function hasPendingAuthorization(sessionState: Record<string, unknown> | undefined): boolean;
export {};
