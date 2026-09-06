/**
 * Full webhook -> durable queue -> native Eve -> sandbox -> model -> Telegram, through rotation.
 *
 * Script: an external group where a human and another bot alternate for SESSION_MAX_COMPLETED_TURNS
 * plus four messages (one of them fails inside the model), then one private message from the owner
 * and one message in the family group. Each message must become exactly one Eve turn that probes
 * the right workspace and answers once; the failed turn answers nothing, shared chats stay silent.
 */
import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { database, closeDatabase } from "../../../agent/lib/database.js";
import { SESSION_MAX_COMPLETED_TURNS } from "../../../agent/config.js";
import { EXTERNAL_TURN_COUNT, FAILING_ORDINAL } from "../agent/agent.js";

const OWNER_TELEGRAM_ID = 902;
const PEER_BOT_ID = 901;
const EXTERNAL_CHAT_ID = -900_000_101;
const FAMILY_CHAT_ID = -900_000_102;
const FIRST_UPDATE_ID = 900_000_000;

export default defineEval({
  timeoutMs: 480_000,
  async test(t) {
    assert.equal(process.env.RUN_DATABASE_INTEGRATION_TESTS, "true");
    assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/osinara_test");
    const db = database();
    await db.query("TRUNCATE users, families CASCADE");
    const totalMessages = EXTERNAL_TURN_COUNT + 2;
    const cursors = new Map<string, number>();
    try {
      await db.query(`CREATE TABLE telegram_conversation_test_deliveries (
        id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000), body jsonb NOT NULL)`);
      await db.query("CREATE TABLE telegram_conversation_test_sandboxes (eve_session_id text NOT NULL, mounts jsonb NOT NULL)");
      const family = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES ('Telegram conversation test') RETURNING id")).rows[0]!;
      const owner = (await db.query<{ id: string }>(
        "INSERT INTO users(telegram_user_id,display_name) VALUES($1,'Human') RETURNING id", [String(OWNER_TELEGRAM_ID)],
      )).rows[0]!;
      await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family.id, owner.id]);
      await db.query(
        "INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,$2,'Family test','family_private','all')",
        [family.id, String(FAMILY_CHAT_ID)],
      );
      const group = (await db.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, tool_allowlist)
         VALUES ($1, $2, 'BotBattle test', 'external', 'all', ARRAY['remember']) RETURNING id`,
        [family.id, String(EXTERNAL_CHAT_ID)],
      )).rows[0]!;

      for (let ordinal = 1; ordinal <= totalMessages; ordinal += 1) {
        const marker = `conversation-probe-${ordinal}`;
        const external = ordinal <= EXTERNAL_TURN_COUNT;
        const fromBot = external && ordinal % 2 === 1;
        const chatId = external ? EXTERNAL_CHAT_ID : ordinal === EXTERNAL_TURN_COUNT + 1 ? OWNER_TELEGRAM_ID : FAMILY_CHAT_ID;
        const message = {
          message_id: ordinal,
          chat: { id: chatId, type: chatId > 0 ? "private" : "supergroup", title: "Conversation test" },
          date: Math.floor(Date.now() / 1_000),
          from: { id: fromBot ? PEER_BOT_ID : OWNER_TELEGRAM_ID, first_name: fromBot ? "Peer bot" : "Human", is_bot: fromBot },
          ...(ordinal % 3 === 0
            ? { rich_message: { blocks: [{ type: "paragraph", text: `Мия, ${marker}` }] } }
            : { text: `Мия, ${marker}` }),
        };
        const response = await t.target.fetch("/eve/v1/telegram", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "conversation-test-secret" },
          body: JSON.stringify({ update_id: FIRST_UPDATE_ID + ordinal, message }),
        });
        assert.equal(response.status, 200);
        let completed = false;
        for (let poll = 0; poll < 600; poll += 1) {
          const row = (await db.query<{ status: string; eve_session_id: string | null; last_error_code: string | null }>(
            "SELECT status,eve_session_id,last_error_code FROM telegram_ingress_updates WHERE update_id = $1",
            [FIRST_UPDATE_ID + ordinal],
          )).rows[0];
          if (row?.status === "failed") throw new Error(`TEST_INGRESS_FAILED at ${marker}: ${row.last_error_code}`);
          if (row?.status === "completed") {
            assert.ok(row.eve_session_id, `No Eve turn for ${marker}`);
            const session = await t.target.attachSession(row.eve_session_id, { startIndex: cursors.get(row.eve_session_id) ?? 0 });
            if (ordinal === FAILING_ORDINAL) {
              session.event("turn.failed");
            } else {
              session.succeeded();
              session.messageIncludes(`reply-${marker}`);
              session.calledTool("probe_workspace");
              if (!external) {
                session.calledTool("bash");
                session.calledSubagent("agent");
              }
            }
            const cursor = (await db.query<{ next_event_index: number }>(
              "SELECT next_event_index FROM eve_session_event_cursors WHERE eve_session_id = $1", [row.eve_session_id],
            )).rows[0]!;
            cursors.set(row.eve_session_id, Number(cursor.next_event_index));
            completed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(completed, `Conversation stalled at ${marker}`);
      }

      const sessions = (await db.query<{ completed_turns: number; generation: number }>(
        "SELECT completed_turns,generation FROM conversation_sessions WHERE group_id=$1 ORDER BY generation", [group.id],
      )).rows;
      assert.deepEqual(sessions.map((s) => s.completed_turns), [SESSION_MAX_COMPLETED_TURNS, EXTERNAL_TURN_COUNT - SESSION_MAX_COMPLETED_TURNS - 1]);
      assert.equal((await db.query("SELECT DISTINCT eve_session_id FROM telegram_conversation_test_sandboxes")).rowCount, 4);
      assert.equal((await db.query("SELECT 1 FROM memory_review_owner_alerts WHERE family_id=$1", [family.id])).rowCount, 0);
      const deliveries = (await db.query<{ body: { chat_id: number | string; text?: string } }>(
        "SELECT body FROM telegram_conversation_test_deliveries",
      )).rows;
      // Terminal diagnostics are private-only: a turn that fails in a shared chat stays silent there.
      const failures = deliveries.filter((d) => (d.body.text ?? "").startsWith("Не удалось выполнить запрос"));
      assert.equal(failures.length, 0, "no failure notice in a shared chat");
      for (let ordinal = 1; ordinal <= totalMessages; ordinal += 1) {
        const replies = deliveries.filter((d) => JSON.stringify(d.body).includes(`reply-conversation-probe-${ordinal}"`));
        assert.equal(replies.length, ordinal === FAILING_ORDINAL ? 0 : 1, `Delivery count for turn ${ordinal}`);
      }
      t.log(`verified ${totalMessages} turns, 4 sessions, all chat modes, a bot-started turn, Bash, native subagents, rotation and recovery`);
    } finally {
      await db.query("TRUNCATE users, families CASCADE");
      await db.query("DELETE FROM telegram_ingress_updates WHERE update_id BETWEEN $1 AND $2", [
        FIRST_UPDATE_ID + 1, FIRST_UPDATE_ID + totalMessages,
      ]);
      await db.query("DROP TABLE IF EXISTS telegram_conversation_test_deliveries, telegram_conversation_test_sandboxes");
      await closeDatabase();
    }
  },
});
