import type { ChannelDeliveryMetadata, SessionTraceContext } from "#channel/types.js";
export interface ChannelDeliverySource {
    readonly channelKind: string;
    readonly channelName: string;
    readonly requestId?: string;
    readonly requestTraceContext?: SessionTraceContext;
}
/** Mints the opaque identity for one inbound channel operation. */
export declare function createChannelDeliveryMetadata(source: ChannelDeliverySource): ChannelDeliveryMetadata;
