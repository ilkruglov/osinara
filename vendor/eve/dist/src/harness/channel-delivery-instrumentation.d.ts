import type { DeliverHookPayload } from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import type { InstrumentationChannelDeliveryOutcome, InstrumentationHooks } from "#harness/instrumentation/lifecycle.js";
interface ChannelDeliveryStartInstrumentation {
    readonly agentName?: string;
    readonly ctx: AlsContext;
    readonly delivery: DeliverHookPayload;
    readonly hooks: InstrumentationHooks | undefined;
    readonly rootSessionId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly turnId: string;
}
interface ChannelDeliveryTerminalInstrumentation {
    readonly ctx: AlsContext;
    readonly error?: unknown;
    readonly errorCode?: string;
    readonly hooks: InstrumentationHooks | undefined;
    readonly includeTurn: boolean;
    readonly outcome: InstrumentationChannelDeliveryOutcome;
}
export declare function instrumentChannelDelivery(input: ChannelDeliveryStartInstrumentation): Promise<void>;
export declare function instrumentChannelDelivery(input: ChannelDeliveryTerminalInstrumentation): Promise<void>;
export declare function channelDeliveryErrorCode(error: unknown): string;
export {};
