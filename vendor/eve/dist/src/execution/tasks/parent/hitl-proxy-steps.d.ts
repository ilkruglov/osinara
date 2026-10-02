import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import { type DurableSessionState } from "#execution/durable-session-store.js";
import { type TaskView } from "#tasks/types.js";
/** Validates and durably records one task-owned child HITL route batch. */
export declare function recordTaskInputRequestStep(input: {
    readonly hookPayload: SubagentInputRequestHookPayload;
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState;
    readonly taskId: string;
}): Promise<{
    readonly accepted: false;
    readonly sessionState: DurableSessionState;
} | {
    readonly accepted: true;
    readonly hookPayload: SubagentInputRequestHookPayload;
    readonly sessionState: DurableSessionState;
}>;
/** Validates that one task authorization event came from its owned child address. */
export declare function acceptTaskAuthorizationEventStep(input: {
    readonly hookPayload: SubagentAuthorizationEventHookPayload;
    readonly sessionState: DurableSessionState;
    readonly taskId: string;
}): Promise<boolean>;
/** Caches terminal task views before their workflow runs can expire. */
export declare function recordTerminalTaskViewsStep(input: {
    readonly sessionState: DurableSessionState;
    readonly views: readonly TaskView[];
}): Promise<DurableSessionState>;
