/**
 * PostgreSQL Telegram group administration repository.
 *
 * Exports:
 * - `TelegramGroupRegistration`: complete persisted registration input.
 * - `TelegramGroupPolicyUpdate`: complete external-group policy replacement input.
 * - `TelegramGroupAdministrationRepository`: injectable registration/removal/policy contract.
 * - `telegramGroupAdministrationRepository`: family-scoped group lifecycle operations.
 */
import { TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED } from "../config.js";
import { AppError } from "./app-error.js";
import { database } from "./database.js";
import type {
  RegisteredGroupType,
  StandardTelegramGroupMessageMode,
  TelegramGroupMessageMode,
} from "./family-access.js";

interface TelegramGroupRegistrationBase {
  familyId: string;
  requestedBy: string;
  telegramChatId: string;
  title: string;
  toolAllowlist: string[];
}

export type TelegramGroupRegistration = TelegramGroupRegistrationBase & (
  | {
    messageMode: StandardTelegramGroupMessageMode;
    type: "family_private";
  }
  | {
    messageMode: TelegramGroupMessageMode;
    type: Exclude<RegisteredGroupType, "family_private">;
  }
);

export interface TelegramGroupPolicyUpdate {
  familyId: string;
  messageMode: TelegramGroupMessageMode;
  requestedBy: string;
  telegramChatId: string;
  toolAllowlist: string[];
}

export interface TelegramGroupAdministrationRepository {
  registerGroup(input: TelegramGroupRegistration): Promise<{ groupId: string }>;
  removeRegistration(input: {
    familyId: string;
    requestedBy: string;
    telegramChatId: string;
  }): Promise<{ groupId: string }>;
  updatePolicy(input: TelegramGroupPolicyUpdate): Promise<{ groupId: string }>;
}

export const telegramGroupAdministrationRepository: TelegramGroupAdministrationRepository = {
  async registerGroup(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Lock current ownership so a parked HITL action cannot outlive role revocation.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Receipt-time media policy and trust-zone replacement share this chat-level lock.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );

      // A type change crosses a trust boundary, so replace the row and cascade all scoped data.
      const existing = await client.query<{ family_id: string; id: string; type: RegisteredGroupType }>(
        `SELECT id, family_id, type
         FROM telegram_groups
         WHERE telegram_chat_id = $1
         FOR UPDATE`,
        [input.telegramChatId],
      );
      const current = existing.rows[0];
      if (current && current.family_id !== input.familyId) {
        throw new AppError(
          "AGENT_GROUP_REGISTRATION_CONFLICT",
          "Группа уже принадлежит другой семье",
        );
      }
      if (current && current.type !== input.type) {
        await client.query("DELETE FROM telegram_groups WHERE id = $1", [current.id]);
      }

      // A conflicting chat owned by another family is never reassigned through an upsert.
      const result = await client.query<{ id: string }>(
        `INSERT INTO telegram_groups
           (family_id, telegram_chat_id, title, type, tool_allowlist, message_mode)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (telegram_chat_id)
         DO UPDATE SET title = EXCLUDED.title,
                       type = EXCLUDED.type,
                       tool_allowlist = EXCLUDED.tool_allowlist,
                       message_mode = EXCLUDED.message_mode
         WHERE telegram_groups.family_id = EXCLUDED.family_id
         RETURNING id`,
        [
          input.familyId,
          input.telegramChatId,
          input.title,
          input.type,
          input.toolAllowlist,
          input.messageMode,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_GROUP_REGISTRATION_CONFLICT",
          "Группа уже принадлежит другой семье",
        );
      }

      await client.query("COMMIT");
      return { groupId: row.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async removeRegistration(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Keep authorization and deletion in one transaction to close the HITL revocation race.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Prevent removal from overtaking an in-flight media trust-zone decision.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );

      // Both group keys remain mandatory so another family's registration is never deleted.
      const result = await client.query<{ id: string }>(
        `DELETE FROM telegram_groups
         WHERE family_id = $1 AND telegram_chat_id = $2
         RETURNING id`,
        [input.familyId, input.telegramChatId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_GROUP_NOT_FOUND",
          "Группа не найдена в вашей семье. Проверьте идентификатор Telegram-чата",
        );
      }
      await client.query("COMMIT");
      return { groupId: row.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async updatePolicy(input) {
    const client = await database().connect();
    try {
      await client.query("BEGIN");

      // Recheck current ownership under a shared row lock after HITL and before any side effect.
      const owner = await client.query(
        `SELECT 1
         FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner'
         FOR SHARE`,
        [input.familyId, input.requestedBy],
      );
      if (!owner.rowCount) {
        throw new AppError("AGENT_OWNER_REQUIRED", "Это действие доступно только владельцу");
      }

      // Serialize against registration, removal, and receipt-time trust decisions for this chat.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
        [input.telegramChatId, TELEGRAM_GROUP_TRUST_LOCK_HASH_SEED],
      );

      // Lock the existing identity in place; policy updates never replace a trust-zone row.
      const existing = await client.query<{ family_id: string; id: string; type: RegisteredGroupType }>(
        `SELECT id, family_id, type
         FROM telegram_groups
         WHERE telegram_chat_id = $1
         FOR UPDATE`,
        [input.telegramChatId],
      );
      const group = existing.rows[0];
      if (!group || group.family_id !== input.familyId) {
        throw new AppError(
          "AGENT_GROUP_NOT_FOUND",
          "Группа не найдена в вашей семье. Проверьте идентификатор Telegram-чата",
        );
      }
      if (group.type === "family_private") {
        throw new AppError(
          "AGENT_GROUP_POLICY_UPDATE_UNSUPPORTED",
          "Политику инструментов можно изменить только у существующей внешней группы",
        );
      }

      // One statement replaces both policy fields atomically without firing deletion cascades.
      const result = await client.query<{ id: string }>(
        `UPDATE telegram_groups
         SET message_mode = $1, tool_allowlist = $2
         WHERE id = $3
         RETURNING id`,
        [input.messageMode, input.toolAllowlist, group.id],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError(
          "AGENT_GROUP_POLICY_UPDATE_FAILED",
          "Не удалось обновить политику группы. Повторите попытку",
        );
      }

      await client.query("COMMIT");
      return { groupId: row.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
