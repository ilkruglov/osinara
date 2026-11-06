/**
 * The deploy's pause of new turns.
 *
 * Exports:
 * - `TURN_START_PAUSED_SQL`: the condition, for queries that claim work to start a turn.
 * - `isTurnStartPaused`: whether a deploy asked the agent to start no new turn right now.
 *
 * Key construct:
 * - The deploy controller (`scripts/production-deploy/backup.sh`) sets the pause before it waits
 *   for the running turns and clears it once the release stopped. Meanwhile the ingress claims no
 *   update (the webhook still stores them) and the minute schedules start no scheduled run or
 *   memory review, so the turns the wait saw are all there is when the release stops. A pause the
 *   controller left behind ends at its own deadline.
 */
import { database } from "../database.js";

export const TURN_START_PAUSED_SQL =
  "EXISTS (SELECT 1 FROM deploy_turn_pause WHERE paused_until > now())";

export async function isTurnStartPaused(
  query: (text: string) => Promise<{ rows: Array<{ paused?: unknown }> }> = (text) => database().query(text),
): Promise<boolean> {
  const result = await query(`SELECT ${TURN_START_PAUSED_SQL} AS paused`);
  return result.rows[0]?.paused === true;
}
