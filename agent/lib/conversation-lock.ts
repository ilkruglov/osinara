/**
 * The transaction lock of one application conversation.
 *
 * Export:
 * - `lockApplicationConversation`: an advisory lock keyed by the conversation id, released at the end
 *   of the transaction.
 *
 * Key construct:
 * - The timeline, the group journal and memory review must exclude each other on the same key. Each
 *   wrote the key expression itself, so a change in one copy would have silently ended the mutual
 *   exclusion; the key now lives here only.
 */
import type { PoolClient } from "pg";

export async function lockApplicationConversation(client: PoolClient, conversationId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [conversationId]);
}
