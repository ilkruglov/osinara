import type { EventType } from '../events.js';
/**
 * Logs that mix events a replay reads past with events that only look like it.
 *
 * Two codebases answer the same question about a log and must answer it the
 * same way. The runtime decides it while replaying: `EventsConsumer` passes
 * over an event whose class it already consumed for that entity and which
 * every registered callback declined. The observability UI decides it after
 * the fact, from the log alone, with no consumers to ask. It stands in for
 * them with the log's own record of when each entity finished, because that is
 * the point past which the runtime has no consumer left for the entity.
 *
 * The two rules agree on every fixture here, and the interesting ones are the
 * near misses: a retried step writes several `step_started` events that are
 * all consumed, and a step that is still open absorbs a second `step_created`.
 * Reading those as repeats would grey out attempts that ran.
 *
 * Each fixture is a whole run's log in log order, which is what both rules
 * take as input. Entities are named, not correlation-id shaped, so each side
 * can mint ids in whatever form it drives.
 */
export interface DuplicateEventFixtureEvent {
    eventType: EventType;
    /** The entity the event belongs to. Run-level events belong to none. */
    entity?: string;
}
export interface DuplicateEventFixture {
    name: string;
    /** What makes this log worth pinning down. */
    why: string;
    /** One run's whole log, in log order. */
    events: DuplicateEventFixtureEvent[];
    /**
     * Indices into {@link events} of the events no consumer claims: the ones the
     * runtime steps over and the UI greys out. Every other index is an event the
     * run acted on.
     */
    ignoredIndices: number[];
}
export declare const DUPLICATE_EVENT_FIXTURES: readonly DuplicateEventFixture[];
//# sourceMappingURL=duplicate-event-fixtures.d.ts.map