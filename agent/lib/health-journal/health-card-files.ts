/**
 * The health journal's card files in the personal workspace.
 *
 * Exports:
 * - `HEALTH_CARD_DIRECTORY`: the one directory every card lives in.
 * - `HealthCardStore`: writing, listing and removing files there (the workspace, or a test double).
 * - `publishHealthCard`: writes one immutable card and drops the older ones of its kind.
 * - `removeHealthCards`: drops every card, for `erase_all`.
 * - `eraseCount`: how many erases the person's journal has seen; it only grows.
 * - `workspaceHealthCardStore`: the production store over the personal workspace.
 *
 * Key constructs (Codex review of 11 November 2026):
 * - A card's file is named by its content hash, so a path always holds its own bytes, never those of
 *   a later card that overwrote a shared name. Each publication writes (a replay restores its own
 *   card), and only cards of the same kind older than `CARD_GRACE_MS` are dropped, so a newer card
 *   or one another call is about to send stays (Codex, third round).
 * - A summary reads the journal, ends its transaction and only then writes the card. An erase that
 *   committed in between is seen by the erase count read again after the write: the card is
 *   removed and the call fails, so erased numbers never come back as a file.
 */
import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { workspaceRepository } from "../workspaces/workspace-repository.js";
import { healthError } from "./health-access.js";

export const HEALTH_CARD_DIRECTORY = "widgets/health";

export type HealthCardKind = "day-evening" | "day-progress" | "week";

export interface HealthCardStore {
  list(): Promise<Array<{ path: string; updatedAt: Date }>>;
  remove(path: string, operationKey: string): Promise<void>;
  write(path: string, bytes: Buffer, operationKey: string): Promise<void>;
}

const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A card younger than this may still be on its way to send_widget; older ones of its kind go. */
const CARD_GRACE_MS = 10 * 60_000;

/** Erases recorded in the journal of operations: an erase leaves one row with its counts. */
export async function eraseCount(
  client: Pick<PoolClient, "query">,
  ownerUserId: string,
): Promise<number> {
  const result = await client.query<{ erases: number }>(
    `SELECT count(*)::integer AS erases FROM health_operations
      WHERE owner_user_id = $1 AND jsonb_typeof(result -> 'erased') = 'object'`,
    [ownerUserId],
  );
  return result.rows[0]!.erases;
}

export async function publishHealthCard(
  store: HealthCardStore,
  input: {
    erasesBefore: number;
    erasesNow: () => Promise<number>;
    html: string;
    kind: HealthCardKind;
    operationKey: string;
  },
): Promise<string> {
  const hash = shortHash(input.html);
  const path = `${HEALTH_CARD_DIRECTORY}/${input.kind}-${hash}.html`;
  // Every publication writes, a replay too: a replay brings back its own card if it was dropped.
  await store.write(
    path,
    Buffer.from(input.html, "utf8"),
    `health-card:${input.operationKey}:${hash}:${randomUUID()}`,
  );
  if ((await input.erasesNow()) !== input.erasesBefore) {
    await store.remove(path, `health-card-erased:${input.operationKey}:${hash}:${randomUUID()}`);
    throw healthError("AGENT_HEALTH_ERASED_MEANWHILE", "Дневник стёрли, пока собиралась карточка", {
      category: "conflict",
      correction: "Не отправляй карточку. Скажи человеку, что дневник стёрт и сводки пока нет.",
      retryable: false,
    });
  }
  // Only cards of this kind older than the grace period go: a newer one, or one another call is
  // about to send, stays.
  const cards = await store.list();
  const written = cards.find((card) => card.path === path)?.updatedAt.getTime() ?? Date.now();
  for (const card of cards)
    if (
      card.path.startsWith(`${HEALTH_CARD_DIRECTORY}/${input.kind}-`) &&
      card.path !== path &&
      card.updatedAt.getTime() < written - CARD_GRACE_MS
    )
      await store.remove(
        card.path,
        `health-card-drop:${input.operationKey}:${shortHash(card.path)}:${randomUUID()}`,
      );
  return path;
}

export async function removeHealthCards(
  store: HealthCardStore,
  operationKey: string,
): Promise<string[]> {
  const cards = (await store.list()).map((card) => card.path);
  for (const card of cards) await store.remove(card, `${operationKey}:card:${shortHash(card)}`);
  return cards;
}

export function workspaceHealthCardStore(auth: () => WorkspaceAuthorization): HealthCardStore {
  return {
    async list() {
      return await workspaceBinaryRepository.listFilesUnder(
        auth(),
        "personal",
        HEALTH_CARD_DIRECTORY,
      );
    },
    async remove(path, operationKey) {
      await workspaceRepository.deleteFile(auth(), "personal", path, operationKey);
    },
    async write(path, bytes, operationKey) {
      await workspaceBinaryRepository.writeBinary(auth(), {
        bytes,
        mediaType: "text/html",
        operationKey,
        path,
        scope: "personal",
      });
    },
  };
}
