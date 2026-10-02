/**
 * Slot-based event identity.
 *
 * An event id is `evnt_` followed by 26 characters. Historically that body was
 * a ULID; a World that allocates *slots* instead writes the event's dense
 * 1-based position in its run's log, as a zero-padded decimal.
 *
 * The padding is what makes this a drop-in change rather than a format break.
 * Decimal digits are a subset of Crockford base32, and every id is still
 * exactly 26 characters, so existing ULID validators accept a slot id,
 * lexicographic ordering still matches creation order (fixed width, so string
 * order is numeric order), and `eid:` cursors and range fences keep working
 * untouched.
 *
 * The one thing that does *not* survive: a slot id's leading characters are
 * zeros, so decoding it as a ULID timestamp yields the Unix epoch. Nothing may
 * derive a time from an event id without first ruling out a slot id — see
 * {@link isSlotBody} and the guard in `ulidToDate`.
 */
/** Characters in an event id body, ULID or slot alike. */
export declare const EVENT_ID_BODY_LENGTH = 26;
/** First slot in a run's log. Slots are 1-based and dense. */
export declare const FIRST_EVENT_SLOT = 1;
/**
 * Largest representable slot. Bounded by JavaScript's safe-integer range
 * rather than by the 16 significant digits the format allows, so a parsed slot
 * is always exact.
 */
export declare const MAX_EVENT_SLOT: number;
/** Canonical prefix for event ids. */
export declare const EVENT_ID_PREFIX = "evnt_";
/**
 * Whether a 26-character event id *body* is a slot rather than a ULID.
 *
 * Takes the body, not the prefixed id, because the same test applies to event
 * ids however they are spelled (`evnt_`, the legacy `wevt_`, or bare).
 */
export declare function isSlotBody(body: string): boolean;
/** Whether a (possibly prefixed) event id is slot-numbered. */
export declare function isSlotEventId(eventId: string): boolean;
/**
 * Formats a slot as a prefixed event id.
 *
 * @throws if the slot is outside the representable range — a caller that
 * overflows must fail loudly rather than mint an id that sorts wrong.
 */
export declare function slotToEventId(slot: number): string;
/**
 * Reads the slot out of a (possibly prefixed) event id, or null when the id is
 * not slot-numbered.
 */
export declare function eventIdToSlot(eventId: string): number | null;
/**
 * Reads the slot out of an event id, for a caller that has no answer without
 * one.
 *
 * Separate from {@link eventIdToSlot} because the two failures are different
 * problems. A caller that can act on either scheme asks the question and takes
 * `null` as an answer; a caller whose whole computation is positional (a
 * precondition snapshot, a density audit) has no correct behaviour to fall back
 * on, and silently skipping the id would make it report a position it never
 * verified. Throwing names the id instead.
 *
 * @throws if the id is not slot-numbered, i.e. the World minting it does not
 * allocate slots.
 */
export declare function requireEventSlot(eventId: string): number;
//# sourceMappingURL=slot-identity.d.ts.map