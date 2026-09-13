/**
 * Durable workspace-file delivery reservation.
 *
 * Exports:
 * - `WorkspaceFileDeliveryReservation`: reserved bytes or a completed replay.
 * - `createWorkspaceFileDeliveryRepository`: PostgreSQL idempotence around external delivery.
 * - `workspaceFileDeliveryRepository`: production repository.
 */
import type { PoolClient } from "pg";
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import type { WorkspaceBinaryFile } from "./workspace-binary-repository.js";
import { workspaceBinaryRepository } from "./workspace-binary-repository.js";
import type {
  WorkspaceAuthorization,
  WorkspaceScope,
} from "./workspace-repository.js";

interface BinaryReader {
  readBinary(
    auth: WorkspaceAuthorization,
    scope: WorkspaceScope,
    path: string,
  ): Promise<WorkspaceBinaryFile>;
}

interface DeliveryRow {
  content_sha256: string;
  file_path: string;
  presentation: "document" | "photo";
  requested_by: string | null;
  status: "completed" | "failed" | "started";
  telegram_chat_id: string;
  telegram_message_id: string | null;
  telegram_message_thread_id: string | null;
  workspace_id: string;
}

interface DeliveryInput {
  chatId: string;
  messageThreadId?: number;
  operationKey: string;
  path: string;
  presentation: "document" | "photo";
  scope: WorkspaceScope;
  turnId: string | null;
}

export type WorkspaceFileDeliveryReservation =
  | ({ status: "completed"; telegramMessageId: string } & WorkspaceBinaryFile)
  // Same bytes, same chat, same turn, a different tool call: already in the chat, do not resend.
  | ({ status: "duplicate"; telegramMessageId: string } & WorkspaceBinaryFile)
  | ({ status: "reserved" } & WorkspaceBinaryFile);

function threadId(value: number | undefined): string | null {
  return value === undefined ? null : String(value);
}

function assertReplayMatches(
  row: DeliveryRow,
  auth: WorkspaceAuthorization,
  binary: WorkspaceBinaryFile,
  input: {
    chatId: string;
    messageThreadId?: number;
    presentation: "document" | "photo";
  },
): void {
  const matches = row.workspace_id === binary.workspaceId &&
    row.file_path === binary.file.path &&
    row.content_sha256 === binary.file.contentSha256 &&
    row.requested_by === auth.userId &&
    row.telegram_chat_id === input.chatId &&
    row.telegram_message_thread_id === threadId(input.messageThreadId) &&
    row.presentation === input.presentation;
  if (!matches) {
    throw new AppError(
      "AGENT_WORKSPACE_FILE_DELIVERY_REPLAY_MISMATCH",
      "Повтор отправки не совпадает с исходным запросом",
    );
  }
}

function replayReservation(
  row: DeliveryRow,
  auth: WorkspaceAuthorization,
  binary: WorkspaceBinaryFile,
  input: DeliveryInput,
): WorkspaceFileDeliveryReservation {
  assertReplayMatches(row, auth, binary, input);
  if (row.status === "completed" && row.telegram_message_id) {
    return { ...binary, status: "completed", telegramMessageId: row.telegram_message_id };
  }
  if (row.status === "started") throw ambiguousDelivery();
  throw new AppError(
    "AGENT_WORKSPACE_FILE_DELIVERY_PREVIOUSLY_FAILED",
    "Прошлая отправка завершилась ошибкой. Создайте новый запрос",
  );
}

function ambiguousDelivery(): AppError {
  return new AppError(
    "AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS",
    "Отправка этих байтов уже начата, но её результат пока не подтверждён. Проверьте файл в чате перед новым запросом",
  );
}

async function findDelivery(client: PoolClient, operationKey: string): Promise<DeliveryRow | undefined> {
  const result = await client.query<DeliveryRow>(
    `SELECT workspace_id, file_path, content_sha256, requested_by, telegram_chat_id,
            telegram_message_thread_id::text, presentation, status, telegram_message_id
       FROM workspace_file_deliveries WHERE operation_key = $1`,
    [operationKey],
  );
  return result.rows[0];
}

async function reserveDelivery(
  client: PoolClient,
  auth: WorkspaceAuthorization,
  binary: WorkspaceBinaryFile,
  input: DeliveryInput,
): Promise<WorkspaceFileDeliveryReservation> {
  if (input.turnId !== null) {
    // Serialize the absence check and reservation across workers. The lock ends before Telegram
    // is called; a committed started row then blocks parallel calls and ambiguous retries.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify(["workspace-delivery", input.chatId, threadId(input.messageThreadId), input.turnId, binary.file.contentSha256]),
    ]);
  }
  const replay = await findDelivery(client, input.operationKey);
  if (replay) return replayReservation(replay, auth, binary, input);

  if (input.turnId !== null) {
    const sent = await client.query<{ status: "completed" | "started"; telegram_message_id: string | null }>(
      `SELECT status, telegram_message_id FROM workspace_file_deliveries
        WHERE telegram_chat_id = $1 AND turn_id = $2 AND content_sha256 = $3
          AND telegram_message_thread_id IS NOT DISTINCT FROM $4::bigint
          AND status IN ('started', 'completed')
        ORDER BY completed_at NULLS LAST LIMIT 1`,
      [input.chatId, input.turnId, binary.file.contentSha256, input.messageThreadId ?? null],
    );
    const previous = sent.rows[0];
    if (previous) {
      if (previous.status !== "completed" || !previous.telegram_message_id) throw ambiguousDelivery();
      return { ...binary, status: "duplicate", telegramMessageId: previous.telegram_message_id };
    }
  }

  const inserted = await client.query(
    `INSERT INTO workspace_file_deliveries
        (family_id, workspace_id, file_path, content_sha256, operation_key, requested_by,
         telegram_chat_id, telegram_message_thread_id, presentation, turn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (operation_key) DO NOTHING`,
    [
      auth.familyId,
      binary.workspaceId,
      binary.file.path,
      binary.file.contentSha256,
      input.operationKey,
      auth.userId,
      input.chatId,
      input.messageThreadId ?? null,
      input.presentation,
      input.turnId,
    ],
  );
  if (inserted.rowCount === 1) return { ...binary, status: "reserved" };
  // The same operation key can race without a turn ID, or with mismatching input. The unique
  // constraint still arbitrates it and the exact replay check must run after that insert settles.
  const row = await findDelivery(client, input.operationKey);
  if (!row) throw new Error("AGENT_WORKSPACE_FILE_DELIVERY_STATE_MISSING");
  return replayReservation(row, auth, binary, input);
}

export function createWorkspaceFileDeliveryRepository(binaryReader: BinaryReader) {
  return {
    async begin(auth: WorkspaceAuthorization, input: DeliveryInput): Promise<WorkspaceFileDeliveryReservation> {
      // Authorization and the byte snapshot precede the short reservation transaction.
      const binary = await binaryReader.readBinary(auth, input.scope, input.path);
      const client = await database().connect();
      try {
        await client.query("BEGIN");
        const reservation = await reserveDelivery(client, auth, binary, input);
        await client.query("COMMIT");
        return reservation;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async complete(operationKey: string, telegramMessageId: string): Promise<void> {
      const result = await database().query(
        `UPDATE workspace_file_deliveries
            SET status = 'completed', telegram_message_id = $2, completed_at = now()
          WHERE operation_key = $1 AND status = 'started'`,
        [operationKey, telegramMessageId],
      );
      if (result.rowCount !== 1) {
        throw new Error("AGENT_WORKSPACE_FILE_DELIVERY_STATE_INVALID: Delivery was not started");
      }
    },

    async fail(operationKey: string, failureCode: string): Promise<void> {
      await database().query(
        `UPDATE workspace_file_deliveries SET status = 'failed', failure_code = $2
          WHERE operation_key = $1 AND status = 'started'`,
        [operationKey, failureCode],
      );
    },
  };
}

export const workspaceFileDeliveryRepository = createWorkspaceFileDeliveryRepository(
  workspaceBinaryRepository,
);
