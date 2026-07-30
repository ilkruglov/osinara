/**
 * Current-time settings repository.
 *
 * Export:
 * - `currentTimeRepository`: reads an authenticated family user's optional IANA timezone.
 */
import { database } from "./database.js";

export const currentTimeRepository = {
  async findUserTimezone(userId: string, familyId: string): Promise<string | null> {
    // Membership binding prevents a stale or cross-family identity from exposing settings.
    const result = await database().query<{ timezone: string }>(
      `SELECT settings.timezone
       FROM user_notification_settings AS settings
       JOIN family_memberships AS membership ON membership.user_id = settings.user_id
       WHERE settings.user_id = $1 AND membership.family_id = $2`,
      [userId, familyId],
    );
    return result.rows[0]?.timezone ?? null;
  },
};
