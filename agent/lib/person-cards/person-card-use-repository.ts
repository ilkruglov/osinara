/**
 * Cards Mia marked used in an answer.
 *
 * Export:
 * - `personCardUseRepository.record`: one row per card and turn, only for cards of the family.
 *
 * The metric of the cards (share of turns that used a card or a profile record) is counted from
 * these rows and `profile_views.person_card_ids`.
 */
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";

export const personCardUseRepository = {
  async record(
    auth: MemoryAuthorization,
    input: { applicationSessionId: string; cardRefs: readonly string[]; sessionTurn: number },
  ): Promise<string[]> {
    if (input.cardRefs.length === 0) return [];
    const result = await database().query<{ card_ref: string }>(
      `INSERT INTO person_card_uses
         (family_id, card_id, card_ref, card_version, application_session_id, session_turn)
       SELECT family_id, id, card_ref, version, $3, $4 FROM person_cards
       WHERE family_id = $1 AND card_ref = ANY($2::text[])
       ON CONFLICT (card_ref, application_session_id, session_turn) DO NOTHING
       RETURNING card_ref`,
      [auth.familyId, input.cardRefs, input.applicationSessionId, input.sessionTurn],
    );
    return result.rows.map((row) => row.card_ref);
  },
};
