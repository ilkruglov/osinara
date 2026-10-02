import type { ChannelAdapter } from "#channel/adapter.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
/** Sends one child-authored progress update over its existing parent transport. */
export declare function executeTaskUpdate(input: {
    readonly action: RuntimeToolCallActionRequest;
    readonly adapter: ChannelAdapter | undefined;
    readonly childStepIndex: number;
    readonly childTurnId: string;
    readonly serializedContext: Record<string, unknown> | undefined;
}): Promise<RuntimeActionResult>;
