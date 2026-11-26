/**
 * Participants' avatars as references for a picture about them.
 *
 * Exports:
 * - `createFetchTelegramAvatarsTool`: dependency-injected tool.
 * - Default `fetch_telegram_avatars`: production tool over Eve's Telegram API and the workspace.
 *
 * Key constructs:
 * - A person is named the way the chat shows them (name, username or Telegram id); every handle,
 *   the id included, resolves through the current conversation's participants, never across chats.
 *   Several handles for one person are fine: each is looked up alone, the most exact first (id,
 *   then username, then name), and a miss falls back to the next; the repository matches any given
 *   field, so two fields at once could name two people. A handle empty once spaces and "@" are gone
 *   is none, and `missing` names the handle that found the person.
 * - The photo lands in the current workspace as `avatars/<telegramUserId>-<fileUniqueId>.jpg`:
 *   a changed avatar is a new file next to the old one, an unchanged one is never downloaded
 *   twice, and the replay key carries the workspace so one chat's file is never another's.
 * - An avatar is a photo of a real person: the style follows the request, photorealism included
 *   (owner, 25 November 2026), but never something demeaning and never passed off as a real photo.
 * - One person failing does not fail the others, and the reason says whether the photo is
 *   absent, Telegram was unavailable or the workspace write failed.
 */
import { defineTool, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import { AppError, isAppError } from "../app-error.js";
import { IMAGE_SOURCES_MAX } from "../image-generation/image-source-schema.js";
import {
  telegramAvatarSource,
  type TelegramAvatarSource,
} from "../attachments/telegram-avatar-source.js";
import {
  conversationRepository,
  type ConversationParticipant,
} from "../conversation-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import type { WorkspaceAuthorization, WorkspaceScope } from "../workspaces/workspace-repository.js";
import type { WorkspaceFileRecord } from "../workspaces/workspace-file-record.js";

type AnyToolDefinition = ToolDefinition<any, any>;

const AVATAR_MEDIA_TYPE = "image/jpeg";
export const AVATAR_USAGE_NOTE =
  "Аватарка это фото живого человека: стиль по просьбе, без названного стиля реалистичный снимок; не для унижения, и картинку не выдавай за настоящее фото. Кто в missing с причиной no_photo_or_private, у того фото нет или оно скрыто: рисуй по описанию, не выдумывая внешность; telegram_unavailable можно повторить позже один раз.";

const participantSchema = z
  .object({
    displayName: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Имя участника так, как оно показано в истории чата"),
    telegramUserId: z
      .string()
      .regex(/^\d+$/u)
      .optional()
      .describe("Telegram user id, если известен"),
    username: z.string().min(1).max(64).optional().describe("Username без @"),
  })
  .strict();

const inputSchema = z
  .object({
    participants: z
      .array(participantSchema)
      .min(1)
      .max(IMAGE_SOURCES_MAX)
      .describe(
        `До ${IMAGE_SOURCES_MAX} участников этого чата; у каждого хотя бы одно из полей, при нескольких ищется по самому точному, при промахе по следующему`,
      ),
  })
  .strict();

type ParticipantHandle = z.infer<typeof participantSchema>;

/**
 * Each given handle alone, the most exact first: id, then username, then name. A handle is cleaned
 * as the repository cleans it (spaces and a leading "@" go), and one left empty is no handle.
 */
function handlesByExactness(participant: ParticipantHandle): ParticipantHandle[] {
  const telegramUserId = participant.telegramUserId?.trim();
  const username = participant.username?.trim().replace(/^@/u, "").trim();
  const displayName = participant.displayName?.trim();
  return [
    ...(telegramUserId ? [{ telegramUserId }] : []),
    ...(username ? [{ username }] : []),
    ...(displayName ? [{ displayName }] : []),
  ];
}

interface FetchTelegramAvatarsDependencies {
  participants: {
    findByHandle(
      conversationId: string,
      handle: { displayName?: string; telegramUserId?: string; username?: string },
    ): Promise<ConversationParticipant | null>;
  };
  source: TelegramAvatarSource;
  workspaces: {
    findBinaryWrite(
      auth: WorkspaceAuthorization,
      scope: WorkspaceScope,
      operationKey: string,
    ): Promise<WorkspaceFileRecord | null>;
    readBinary(auth: WorkspaceAuthorization, scope: WorkspaceScope, path: string): Promise<unknown>;
    workspaceId(auth: WorkspaceAuthorization, scope: WorkspaceScope): Promise<string>;
    writeBinary(
      auth: WorkspaceAuthorization,
      input: {
        bytes: Uint8Array;
        mediaType: string;
        operationKey: string;
        path: string;
        scope: WorkspaceScope;
      },
    ): Promise<WorkspaceFileRecord>;
  };
}

export interface FetchedAvatar {
  displayName: string | null;
  mediaType: string;
  path: string;
  scope: WorkspaceScope;
  status: "cached" | "saved";
  telegramUserId: string;
  username: string | null;
}

export type MissingAvatarReason =
  "no_photo_or_private" | "storage_failed" | "telegram_unavailable" | "unknown_participant";

function parseInput(input: unknown): { participants: ParticipantHandle[][] } {
  const parsed = inputSchema.safeParse(input);
  const participants = parsed.success ? parsed.data.participants.map(handlesByExactness) : [];
  if (!parsed.success || participants.some((handles) => handles.length === 0)) {
    throw new AppError(
      "AGENT_TELEGRAM_AVATARS_INPUT_INVALID",
      `Укажи до ${IMAGE_SOURCES_MAX} участников, у каждого хотя бы одно из полей: telegramUserId, username или displayName`,
    );
  }
  return { participants };
}

function workspaceScopeOf(auth: WorkspaceAuthorization): WorkspaceScope {
  if (auth.telegramChatType === "private" && auth.userId !== null) return "personal";
  if (auth.telegramChatType !== "private" && auth.groupId !== null) {
    if (auth.groupType === "family_private") return "family";
    if (auth.groupType === "external") return "group";
  }
  throw new AppError(
    "AGENT_WORKSPACE_CONTEXT_INVALID",
    "Не удалось определить область для сохранения аватарок",
  );
}

function requested(handle: ParticipantHandle): string {
  return handle.telegramUserId ?? handle.username ?? handle.displayName ?? "";
}

/** The workspace still holds the file the ledger remembers; a removed file is a cache miss. */
async function fileStillThere(
  dependencies: FetchTelegramAvatarsDependencies,
  auth: WorkspaceAuthorization,
  scope: WorkspaceScope,
  path: string,
): Promise<boolean> {
  try {
    await dependencies.workspaces.readBinary(auth, scope, path);
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === "AGENT_WORKSPACE_FILE_NOT_FOUND") return false;
    throw error;
  }
}

export function createFetchTelegramAvatarsTool(
  dependencies: FetchTelegramAvatarsDependencies,
): AnyToolDefinition {
  return defineTool({
    description: [
      "Когда использовать: перед картинкой, на которой должны быть узнаваемы участники этого чата (обложка про события чата, карикатура, сцена с ними), чтобы передать их аватарки в generate_image как images-референсы.",
      `Вход: до ${IMAGE_SOURCES_MAX} участников, каждый по telegramUserId, username или имени из истории чата (при нескольких полях ищется по самому точному: id, username, имя; при промахе по следующему); доступны только участники текущего разговора.`,
      "Результат: для каждого найденного path и scope для images (status cached значит, что файл уже был в workspace); missing перечисляет остальных с причиной: unknown_participant, no_photo_or_private, telegram_unavailable, storage_failed.",
      AVATAR_USAGE_NOTE,
      "Не использовать: без картинки про этих людей и ради любопытства. Чьё лицо брать, решает просьба: кто дал своё фото для этой картинки (прислал или указал), того рисуют по фото, если он сам не просит лицо с аватарки.",
    ].join(" "),
    inputSchema,
    async execute(rawInput, ctx) {
      const input = parseInput(rawInput);
      const auth = requireWorkspaceAuthorization(ctx);
      const scope = workspaceScopeOf(auth);
      // Every handle, the Telegram id included, resolves through the participants of this
      // conversation: nobody outside it is reachable, and no conversation means nobody is.
      const conversationId = ctx.session.auth.current?.attributes.telegramConversationId;
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        throw new AppError(
          "AGENT_TELEGRAM_AVATARS_CONTEXT_INVALID",
          "Аватарки доступны только внутри проверенного разговора",
        );
      }
      const workspaceId = await dependencies.workspaces.workspaceId(auth, scope);
      const avatars: FetchedAvatar[] = [];
      const missing: { reason: MissingAvatarReason; requested: string }[] = [];
      for (const handles of input.participants) {
        // The result names the handle that found the person, or the first one when none did.
        let handle = handles[0]!;
        let found: ConversationParticipant | null = null;
        for (const candidate of handles) {
          found = await dependencies.participants.findByHandle(conversationId, candidate);
          if (found !== null) {
            handle = candidate;
            break;
          }
        }
        if (found === null) {
          missing.push({ reason: "unknown_participant", requested: requested(handle) });
          continue;
        }
        const participant = {
          displayName: found.displayNameSnapshot,
          telegramUserId: found.telegramUserId,
          username: found.usernameSnapshot,
        };
        let stage: "storage" | "telegram" = "telegram";
        try {
          const lookup = await dependencies.source.lookup(participant.telegramUserId);
          if (lookup.status === "none") {
            missing.push({ reason: "no_photo_or_private", requested: requested(handle) });
            continue;
          }
          // One file per avatar version per workspace: a changed photo lands next to the old one.
          const path = `avatars/${participant.telegramUserId}-${lookup.photo.fileUniqueId}.jpg`;
          const operationKey = `avatar:${workspaceId}:${participant.telegramUserId}:${lookup.photo.fileUniqueId}`;
          stage = "storage";
          const remembered = await dependencies.workspaces.findBinaryWrite(
            auth,
            scope,
            operationKey,
          );
          const cached =
            remembered !== null &&
            (await fileStillThere(dependencies, auth, scope, remembered.path))
              ? remembered
              : null;
          let file = cached;
          if (file === null) {
            stage = "telegram";
            const bytes = await dependencies.source.download(lookup.photo);
            stage = "storage";
            // A removed file is written again under a fresh key: the old key would replay the
            // record without the bytes. Two concurrent first writes race on the key; the loser
            // takes the winner's record instead of reporting a failure.
            const key = remembered === null ? operationKey : `${operationKey}:${Date.now()}`;
            try {
              file = await dependencies.workspaces.writeBinary(auth, {
                bytes,
                mediaType: AVATAR_MEDIA_TYPE,
                operationKey: key,
                path,
                scope,
              });
            } catch (error) {
              const winner = await dependencies.workspaces.findBinaryWrite(auth, scope, key);
              if (winner === null) throw error;
              file = winner;
            }
          }
          console.info(
            JSON.stringify({
              code: "AGENT_TELEGRAM_AVATAR_FETCHED",
              bytes: file.byteSize,
              cached: cached !== null,
            }),
          );
          avatars.push({
            displayName: participant.displayName,
            mediaType: file.mediaType,
            path: file.path,
            scope,
            status: cached === null ? "saved" : "cached",
            telegramUserId: participant.telegramUserId,
            username: participant.username,
          });
        } catch (error) {
          // One person's failure is reported in the result, never thrown over the others.
          console.warn(
            JSON.stringify({
              code: "AGENT_TELEGRAM_AVATAR_FAILED",
              stage,
              error: isAppError(error)
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "unknown",
            }),
          );
          missing.push({
            reason: stage === "storage" ? "storage_failed" : "telegram_unavailable",
            requested: requested(handle),
          });
        }
      }
      return { avatars, missing, note: AVATAR_USAGE_NOTE, scope };
    },
  }) as AnyToolDefinition;
}

export default createFetchTelegramAvatarsTool({
  participants: {
    findByHandle: (conversationId, handle) =>
      conversationRepository.findParticipantByHandle(conversationId, handle),
  },
  source: telegramAvatarSource,
  workspaces: workspaceBinaryRepository,
});
