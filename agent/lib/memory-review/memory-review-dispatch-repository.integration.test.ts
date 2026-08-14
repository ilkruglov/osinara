/**
 * Memory-review dispatch crash-recovery PostgreSQL integration tests.
 *
 * Constructs covered:
 * - Bounded pre-handoff recovery, owner alerts, stale markers, and exact Eve-root ownership.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { createMainAgentMemoryFixture } from "../memory-agent-write.integration-fixtures.js";
import { memoryReviewDispatchRepository } from "./memory-review-dispatch-repository.js";
import { memoryReviewOwnerAlertRepository } from "./memory-review-owner-alert-repository.js";
import { memoryReviewRepository } from "./memory-review-repository.js";
import { memoryReviewSessionRepository } from "./memory-review-session-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

async function insertUserMessage(input: {
  conversationId: string;
  groupId: string;
  sequence: number;
}) {
  return (await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, $3, 'user', 'telegram:agent-memory-author',
             'agent-memory-author', 'Анна', false, 'text', $4, now()) RETURNING id`,
    [input.conversationId, input.groupId, input.sequence, `Сообщение памяти ${input.sequence}`],
  )).rows[0]!;
}

async function claimBackgroundBatch() {
  const fixture = await createMainAgentMemoryFixture();
  for (let sequence = 2; sequence <= 51; sequence += 1) {
    const source = await insertUserMessage({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
      sequence,
    });
    await memoryReviewRepository.observePassiveMessage({
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
  }
  const [claim] = await memoryReviewDispatchRepository.claimPending({
    leaseMilliseconds: 60_000,
    limit: 1,
    now: new Date("2026-08-12T10:00:00.000Z"),
  });
  return { claim: claim!, fixture };
}

describeWithDatabase("memory review dispatch repository", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("retires a prepared background session when its Eve handoff is ambiguous", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(
      claim,
      new Date("2026-08-12T10:00:01.000Z"),
    );
    await memoryReviewDispatchRepository.markAmbiguous(
      claim,
      "AGENT_MEMORY_REVIEW_DISPATCH_MARKER_AMBIGUOUS",
      session.id,
    );

    await expect(database().query(
      `SELECT app_session.task_state::text, app_session.retired_at,
              count(source.timeline_entry_id)::integer AS source_count,
              alert.status::text AS alert_status
         FROM conversation_sessions AS app_session
         JOIN memory_review_batches AS batch ON batch.application_session_id = app_session.id
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
         LEFT JOIN memory_review_owner_alerts AS alert ON alert.batch_id = batch.id
        WHERE app_session.id = $1
        GROUP BY app_session.id, alert.id`,
      [session.id],
    )).resolves.toMatchObject({
      rows: [{
        alert_status: "pending",
        retired_at: expect.any(Date),
        source_count: 50,
        task_state: "failed",
      }],
    });
  });

  it("retries one pre-handoff failure, then blocks and alerts without releasing sources", async () => {
    const { claim } = await claimBackgroundBatch();

    await expect(memoryReviewDispatchRepository.failClaim(
      claim,
      "AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED",
    )).resolves.toBe("retry_scheduled");
    await expect(database().query(
      `SELECT batch.status::text, batch.recovery_attempts,
              batch.last_recovery_diagnostic_code,
              count(source.timeline_entry_id)::integer AS source_count,
              count(alert.id)::integer AS alert_count
         FROM memory_review_batches AS batch
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
         LEFT JOIN memory_review_owner_alerts AS alert ON alert.batch_id = batch.id
        WHERE batch.id = $1 GROUP BY batch.id`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{
      alert_count: 0,
      last_recovery_diagnostic_code: "AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED",
      recovery_attempts: 1,
      source_count: 50,
      status: "pending",
    }] });

    const [retried] = await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:01:00.000Z"),
    });
    await expect(memoryReviewDispatchRepository.failClaim(
      retried!,
      "AGENT_MEMORY_REVIEW_SESSION_PREPARATION_FAILED",
    )).resolves.toBe("failed");
    await expect(database().query(
      `SELECT batch.status::text, count(source.timeline_entry_id)::integer AS source_count,
              alert.status::text AS alert_status
         FROM memory_review_batches AS batch
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
         LEFT JOIN memory_review_owner_alerts AS alert ON alert.batch_id = batch.id
        WHERE batch.id = $1 GROUP BY batch.id, alert.id`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{
      alert_status: "pending",
      source_count: 50,
      status: "failed",
    }] });
  });

  it("leases a terminal alert to the current owner and records one-shot delivery", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(claim, new Date());
    await memoryReviewDispatchRepository.markAmbiguous(
      claim,
      "AGENT_MEMORY_REVIEW_HANDOFF_AMBIGUOUS",
      session.id,
    );

    const [alert] = await memoryReviewOwnerAlertRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:01:00.000Z"),
    });
    expect(alert).toMatchObject({
      batchId: claim.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_HANDOFF_AMBIGUOUS",
      groupTitle: "Семья",
      ownerTelegramUserId: "agent-memory-author",
    });
    await memoryReviewOwnerAlertRepository.markDelivered(alert!);

    await expect(memoryReviewOwnerAlertRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:02:00.000Z"),
    })).resolves.toEqual([]);
    await expect(database().query(
      "SELECT status::text, completed_at FROM memory_review_owner_alerts WHERE id = $1",
      [alert!.alertId],
    )).resolves.toMatchObject({
      rows: [{ completed_at: expect.any(Date), status: "delivered" }],
    });
  });

  it("reuses an unstarted application session after a pre-marker process crash", async () => {
    const { claim } = await claimBackgroundBatch();
    const first = await memoryReviewSessionRepository.prepare(
      claim,
      new Date("2026-08-12T10:00:01.000Z"),
    );
    const recovered = await memoryReviewSessionRepository.prepare(
      claim,
      new Date("2026-08-12T10:02:00.000Z"),
    );

    expect(recovered).toEqual(first);
  });

  it("terminalizes a stale dispatch marker and its one-shot application session", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(
      claim,
      new Date("2026-08-12T10:00:01.000Z"),
    );
    await memoryReviewDispatchRepository.markDispatchStarted(claim, session.id);

    await memoryReviewDispatchRepository.claimPending({
      leaseMilliseconds: 60_000,
      limit: 1,
      now: new Date("2026-08-12T10:02:00.000Z"),
    });

    await expect(database().query(
      `SELECT batch.status::text, batch.diagnostic_code, app_session.task_state::text,
              app_session.retired_at
         FROM memory_review_batches AS batch
         JOIN conversation_sessions AS app_session ON app_session.id = batch.application_session_id
        WHERE batch.id = $1`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{
      diagnostic_code: "AGENT_MEMORY_REVIEW_DISPATCH_TIMEOUT_AMBIGUOUS",
      retired_at: expect.any(Date),
      status: "ambiguous",
      task_state: "failed",
    }] });
  });

  it("keeps a running background batch intact for a competing Eve root failure", async () => {
    const { claim } = await claimBackgroundBatch();
    const session = await memoryReviewSessionRepository.prepare(claim, new Date());
    await memoryReviewDispatchRepository.markDispatchStarted(claim, session.id);
    await memoryReviewDispatchRepository.markRunning(claim, {
      applicationSessionId: session.id,
      eveSessionId: "eve-authoritative-root",
    });

    await memoryReviewDispatchRepository.markSessionAmbiguous({
      batchId: claim.batchId,
      diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
      eveSessionId: "eve-competing-root",
    });

    await expect(database().query(
      `SELECT batch.status::text, count(source.timeline_entry_id)::integer AS source_count
         FROM memory_review_batches AS batch
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
        WHERE batch.id = $1 GROUP BY batch.id`,
      [claim.batchId],
    )).resolves.toMatchObject({ rows: [{ source_count: 50, status: "running" }] });
  });

  it("atomically marks an interactive session failure and retains its sources for repair", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const session = await database().query<{ id: string }>(
      `INSERT INTO conversation_sessions
         (thread_id, generation, family_id, group_id, scope, kind, conversation_key,
          continuation_token, started_at, last_activity_at)
       VALUES (gen_random_uuid(), 0, $1, $2, 'family', 'canonical', 'review-session-failure',
               'review-session-failure', now(), now()) RETURNING id`,
      [fixture.familyId, fixture.groupId],
    );
    const source = await insertUserMessage({
      conversationId: fixture.conversationId,
      groupId: fixture.groupId,
      sequence: 2,
    });
    const batch = await memoryReviewRepository.prepareInteractiveTurn({
      applicationSessionId: session.rows[0]!.id,
      groupId: fixture.groupId,
      timelineEntryId: source.id,
    });
    await memoryReviewRepository.bindEveTurn({
      applicationSessionId: session.rows[0]!.id,
      batchId: batch!.batchId,
      eveSessionId: "eve-interactive-session-failure",
      eveTurnId: "turn-interactive-session-failure",
    });
    await database().query(
      "UPDATE conversation_sessions SET eve_session_id = $2 WHERE id = $1",
      [session.rows[0]!.id, "eve-interactive-session-failure"],
    );

    await expect(memoryReviewDispatchRepository.markInteractiveSessionAmbiguous({
      continuationToken: "review-session-failure",
      diagnosticCode: "AGENT_MEMORY_REVIEW_SESSION_FAILED_AMBIGUOUS",
      eveSessionId: "eve-interactive-session-failure",
    })).resolves.toBe("recorded");
    await expect(database().query(
      `SELECT batch.status::text, app_session.rotation_requested_at,
              count(source.timeline_entry_id)::integer AS source_count,
              alert.status::text AS alert_status
         FROM memory_review_batches AS batch
         JOIN conversation_sessions AS app_session ON app_session.id = batch.application_session_id
         LEFT JOIN memory_review_batch_sources AS source ON source.batch_id = batch.id
         LEFT JOIN memory_review_owner_alerts AS alert ON alert.batch_id = batch.id
         WHERE batch.id = $1 GROUP BY batch.id, app_session.id, alert.id`,
      [batch!.batchId],
    )).resolves.toMatchObject({ rows: [{
      alert_status: "pending",
      rotation_requested_at: expect.any(Date), source_count: 2, status: "ambiguous",
    }] });
  });
});
