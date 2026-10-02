/**
 * Id generator shared by `registerOTel` and the agent OTel provider. A span
 * whose lifetime crosses durable worker boundaries (`agent.turn`) is emitted
 * at its terminal; priming the next span id lets that span carry the
 * pre-allocated id its descendants already parented to.
 */
export declare class AgentSpanIdGenerator {
    #private;
    /** Reserves a span id for a span emitted later via {@link withSpanId}. */
    allocateSpanId(): string;
    /** Derives one span id for a replay-stable instrumentation event. */
    deriveSpanId(key: string): string;
    generateSpanId(): string;
    generateTraceId(): string;
    /** Runs `startSpan` so the next span started carries `spanId`. */
    withSpanId<T>(spanId: string, startSpan: () => T): T;
}
