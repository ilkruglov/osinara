import type { SubagentAuthorizationEventHookPayload, SubagentInputRequestHookPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { type DurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
type SubagentEventHookPayload = SubagentAuthorizationEventHookPayload | SubagentInputRequestHookPayload;
interface ProxySubagentEventResult {
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}
/** Proxies one child event through its parent channel across a durable step boundary. */
export declare function runProxySubagentEventStep(input: {
    readonly hookPayload: SubagentEventHookPayload;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}): Promise<ProxySubagentEventResult>;
/** Emits a task request whose proxy routes were committed by a prior step. */
export declare function emitRecordedTaskInputRequestStep(input: {
    readonly hookPayload: SubagentInputRequestHookPayload;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}): Promise<ProxySubagentEventResult>;
/** Emits a task authorization event after its ownership was validated. */
export declare function emitRecordedTaskAuthorizationEventStep(input: {
    readonly hookPayload: SubagentAuthorizationEventHookPayload;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
}): Promise<ProxySubagentEventResult>;
/** Applies one proxied child event to an already-hydrated parent context. */
export declare function emitProxiedSubagentEvent(input: {
    readonly ctx: ContextContainer;
    readonly durableSession: DurableSession;
    readonly hookPayload: SubagentEventHookPayload;
    readonly parentWritable: WritableStream<Uint8Array>;
    readonly recordProxyInputRequests?: boolean;
}): Promise<ProxySubagentEventResult>;
export {};
