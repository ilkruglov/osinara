import type { ModelMessage, SystemModelMessage } from "ai";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import type { AlsContext, ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
/**
 * Builds the flattened system messages from session + turn durable keys.
 * Session-scoped entries appear first.
 */
export declare function buildDynamicInstructionMessages(ctx: {
    get<T>(key: ContextKey<T>): T | undefined;
}): SystemModelMessage[];
/** Starts the instructions-only virtual context for one lifecycle preamble. */
export declare function prepareDynamicInstructionPreamble(ctx: AlsContext, messages: readonly ModelMessage[]): void;
/** Drains user-role results and clears the instructions-only virtual context. */
export declare function drainDynamicInstructionUserMessages(ctx: AlsContext): ModelMessage[];
/**
 * Dispatches a stream event to dynamic instruction resolvers.
 *
 * Each resolver's output replaces its own slot (keyed by slug) in the
 * scope-appropriate durable key (session or turn). The tool-loop calls
 * {@link buildDynamicInstructionMessages} to assemble the flattened
 * result for the model call.
 */
export declare function dispatchDynamicInstructionEvent(input: {
    readonly ctx: ContextContainer;
    readonly resolvers: readonly ResolvedDynamicInstructionsResolver[];
    readonly event: UnstampedMessageStreamEvent;
    readonly messages: readonly ModelMessage[];
}): Promise<void>;
