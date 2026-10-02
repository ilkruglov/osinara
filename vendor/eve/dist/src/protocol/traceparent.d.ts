export interface TraceparentContext {
    readonly isRemote?: boolean;
    readonly spanId: string;
    readonly traceFlags: number;
    readonly traceId: string;
}
/** Formats a W3C version-00 traceparent, or omits an invalid context. */
export declare function formatTraceparent(context: TraceparentContext | undefined): string | undefined;
/** Parses a W3C version-00 traceparent without rejecting the containing request. */
export declare function parseTraceparent(value: string | null): TraceparentContext | undefined;
