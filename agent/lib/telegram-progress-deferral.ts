/**
 * Holds a pre-tool progress notice until the step's tool names are known.
 *
 * Exports:
 * - `QUIET_TOOL_NAMES`: fast bookkeeping tools a person never waits on.
 * - `createProgressNoticeDeferral`, `telegramProgressNoticeDeferral`: per-turn hold / release logic.
 *
 * Key constructs:
 * - DeepSeek often writes the whole answer and calls `remember` in the same step. Sending that text
 *   as a progress notice and then delivering the next step's answer produced two near-identical
 *   messages. The text is now held until `actions.requested` names the tools: a slow tool releases
 *   it at once, a quiet tool keeps it held; the next visible text supersedes it, and a turn that ends
 *   with the text still held delivers it as the answer so nothing is lost.
 * - State is in-process and keyed by session and turn; a restart loses at most one held notice,
 *   and the durable notice claim still guards against duplicates.
 * - A sent notice is remembered for the rest of the turn: the model sees a note in the next tool
 *   result that its pre-tool text already reached the person, so the final message carries only
 *   what is new instead of answering every topic a second time.
 */

const QUIET_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_current_time", "get_memory_source", "list_agent_schedules", "list_memories",
  "list_memory_threads", "list_pending_family_invitations", "list_proactive_deliveries",
  "list_reminders", "list_telegram_attachments", "load_skill", "manage_behavior_preference",
  "manage_memory", "manage_memory_conflict", "manage_memory_thread", "manage_skill",
  "notification_settings", "read_memory_thread", "read_profile_view", "remember",
  "search_memories", "search_memory_threads",
]);

export interface HeldProgressNotice {
  /** Resolves with the ids of the messages sent, when the sender reports them. */
  readonly send: () => Promise<readonly string[] | void>;
  readonly stepIndex: number;
}

export function progressNoticeKey(eveSessionId: string, eveTurnId: string): string {
  return `${eveSessionId}\u0000${eveTurnId}`;
}

/** Model-facing note attached to a tool result once a notice of the same turn went out. */
export const PROGRESS_NOTICE_SENT_NOTE =
  "Текст, который ты написала перед этим вызовом, пользователь уже получил отдельным сообщением. В следующем сообщении пиши только новое: результат и что с ним делать, без пересказа уже отправленного.";

export function createProgressNoticeDeferral() {
  const held = new Map<string, HeldProgressNotice>();
  const sent = new Set<string>();

  return {
    /** New pre-tool text replaces whatever was held: the model has re-answered. */
    hold(key: string, notice: HeldProgressNotice): void {
      held.set(key, notice);
    },

    /** Final visible text or a reaction makes the held notice obsolete. */
    discard(key: string): void {
      held.delete(key);
    },

    /** Releases the held notice at once when the step calls anything a person would wait on. */
    async release(key: string, stepIndex: number, toolNames: readonly string[]): Promise<void> {
      const notice = held.get(key);
      if (!notice || notice.stepIndex !== stepIndex) return;
      if (toolNames.length > 0 && toolNames.every((name) => QUIET_TOOL_NAMES.has(name))) return;
      held.delete(key);
      // Marked before the send completes: the step's tools may finish while Telegram is answering.
      sent.add(key);
      await notice.send();
    },

    /** Whether a notice of this turn already reached the person. */
    wasSent(key: string): boolean {
      return sent.has(key);
    },

    /** End of turn: nothing held or remembered may leak into the next one. */
    forget(key: string): void {
      held.delete(key);
      sent.delete(key);
    },

    /** A turn ending with text still held delivers it: it was the answer after all. */
    async flush(key: string): Promise<readonly string[]> {
      const notice = held.get(key);
      if (!notice) return [];
      held.delete(key);
      return (await notice.send()) ?? [];
    },

    heldCount(): number {
      return held.size;
    },
  };
}

export const telegramProgressNoticeDeferral = createProgressNoticeDeferral();
