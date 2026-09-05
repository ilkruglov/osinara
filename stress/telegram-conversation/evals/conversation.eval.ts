/** Full webhook -> durable queue -> native Eve -> sandbox -> model -> Telegram, through rotation. */
import assert from "node:assert/strict";
import { defineEval } from "eve/evals";
import { database, closeDatabase } from "../../../agent/lib/database.js";
import { SESSION_MAX_COMPLETED_TURNS } from "../../../agent/config.js";

export default defineEval({
  timeoutMs: 240_000,
  async test(t) {
    assert.equal(process.env.RUN_DATABASE_INTEGRATION_TESTS, "true");
    assert.equal(new URL(process.env.DATABASE_URL!).pathname, "/osinara_test");
    const db = database();
    await db.query("TRUNCATE users, families CASCADE");
    const family = (await db.query<{ id: string }>("INSERT INTO families(name) VALUES ('Telegram conversation test') RETURNING id")).rows[0]!;
    const chatId = -900_000_101;
    const familyChatId = -900_000_102;
    const turnCount = SESSION_MAX_COMPLETED_TURNS + 4;
    const failingOrdinal = SESSION_MAX_COMPLETED_TURNS + 3;
    const cursors = new Map<string, number>();
    try {
      await db.query(`CREATE TABLE telegram_conversation_test_deliveries (
        id integer GENERATED ALWAYS AS IDENTITY (START WITH 10000), body jsonb NOT NULL)`);
      await db.query("CREATE TABLE telegram_conversation_test_sandboxes (eve_session_id text NOT NULL, mounts jsonb NOT NULL)");
      const owner = (await db.query<{ id: string }>("INSERT INTO users(telegram_user_id,display_name) VALUES('902','Human') RETURNING id")).rows[0]!;
      await db.query("INSERT INTO family_memberships(family_id,user_id,role) VALUES($1,$2,'owner')", [family.id, owner.id]);
      await db.query("INSERT INTO telegram_groups(family_id,telegram_chat_id,title,type,message_mode) VALUES($1,$2,'Family test','family_private','all')", [family.id, String(familyChatId)]);
      const group = (await db.query<{ id: string }>(
        `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode, skill_allowlist, tool_allowlist)
         VALUES ($1, $2, 'BotBattle test', 'external', 'all', ARRAY['pohuy'], ARRAY['remember','bash']) RETURNING id`,
        [family.id, String(chatId)],
      )).rows[0]!;
      for (let ordinal = 1; ordinal <= turnCount + 2; ordinal += 1) {
        const marker = `conversation-probe-${ordinal}`;
        const isBot = ordinal <= turnCount && ordinal % 2 === 1;
        const currentChatId = ordinal <= turnCount ? chatId : ordinal === turnCount + 1 ? 902 : familyChatId;
        const message = {
          message_id: ordinal,
          chat: { id: currentChatId, type: currentChatId > 0 ? "private" : "supergroup", title: "Conversation test" },
          date: Math.floor(Date.now() / 1_000),
          from: { id: isBot ? 901 : 902, first_name: isBot ? "Peer bot" : "Human", is_bot: isBot },
          ...(ordinal <= turnCount ? { reply_to_message: {
            message_id: 9000,
            chat: { id: chatId, type: "supergroup" },
            date: Math.floor(Date.now() / 1_000),
            from: { id: 903, is_bot: true, first_name: "Other bot", username: "other_bot" },
            text: "Previous participant message",
          } } : {}),
          ...(ordinal % 3 === 0
            ? { rich_message: { blocks: [{ type: "paragraph", text: `@osinara_bot ${marker}` }] } }
            : { text: `@osinara_bot ${marker}` }),
        };
        const response = await t.target.fetch("/eve/v1/telegram", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": "conversation-test-secret" },
          body: JSON.stringify({ update_id: 900_000_000 + ordinal, message }),
        });
        assert.equal(response.status, 200);
        let completed = false;
        for (let poll = 0; poll < 150; poll += 1) {
          const result = await db.query<{ status: string; eve_session_id: string | null; last_error_code: string | null }>(
            "SELECT status,eve_session_id,last_error_code FROM telegram_ingress_updates WHERE update_id = $1",
            [900_000_000 + ordinal],
          );
          const row = result.rows[0];
          if (row?.status === "failed") throw new Error(`TEST_INGRESS_FAILED: ${row.last_error_code}`);
          if (row?.status === "completed") {
            assert.ok(row.eve_session_id, `No Eve turn for ${marker}`);
            const session = await t.target.attachSession(row.eve_session_id, { startIndex: cursors.get(row.eve_session_id) ?? 0 });
            if (ordinal === failingOrdinal) {
              session.event("turn.failed");
              session.event("session.waiting");
            } else {
              session.succeeded();
              session.messageIncludes(`reply-${marker}`);
              session.calledTool("probe_workspace");
              session.calledTool("bash");
              if (ordinal === 1 || ordinal === SESSION_MAX_COMPLETED_TURNS + 1 || ordinal > turnCount) {
                session.loadedSkill("pohuy");
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
      assert.deepEqual(sessions.map((s) => s.completed_turns), [SESSION_MAX_COMPLETED_TURNS, 3]);
      assert.equal((await db.query("SELECT DISTINCT eve_session_id FROM telegram_conversation_test_sandboxes")).rowCount, 4);
      assert.equal((await db.query("SELECT 1 FROM memory_review_owner_alerts WHERE family_id=$1", [family.id])).rowCount, 0);
      const deliveries = (await db.query<{ body: { text: string; reply_parameters?: { message_id: number } } }>(
        "SELECT body FROM telegram_conversation_test_deliveries",
      )).rows;
      const notices = deliveries.filter((d) => !d.body.text.startsWith("reply-conversation-probe-"));
      assert.equal(notices.length, 2);
      assert.equal(notices.filter((d) => d.body.text.startsWith("AGENT_PROFILE_PROJECTION_POLICY_NOTICE:")).length, 1);
      assert.equal(notices.filter((d) => d.body.text === "Нейросеть сейчас недоступна.\n\nПопробуйте повторить запрос чуть позже." &&
        d.body.reply_parameters?.message_id === failingOrdinal).length, 1);
      assert.equal(deliveries.length - notices.length, turnCount + 1);
      for (let ordinal = 1; ordinal <= turnCount + 2; ordinal += 1) {
        const replies = deliveries.filter((d) => JSON.stringify(d.body).includes(`reply-conversation-probe-${ordinal}\"`));
        assert.equal(replies.length, ordinal === failingOrdinal ? 0 : 1, `Delivery count for turn ${ordinal}`);
      }
      t.log(`verified ${turnCount + 2} turns, 4 sessions, all chat modes, granted skills, Bash, native subagents, rotation and recovery`);
    } finally {
      await db.query("TRUNCATE users, families CASCADE");
      await db.query("DELETE FROM telegram_ingress_updates WHERE update_id BETWEEN $1 AND $2", [
        900_000_001, 900_000_000 + turnCount + 2,
      ]);
      await db.query("DROP TABLE IF EXISTS telegram_conversation_test_deliveries, telegram_conversation_test_sandboxes");
      await closeDatabase();
    }
  },
});
