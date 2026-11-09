/**
 * Pacing of outbound Telegram Bot API calls under Telegram's limits.
 *
 * Exports:
 * - `createTelegramSendPacer`: a pacer with its own clock, for tests.
 * - `telegramSendPacerSettings`: the three limits from the environment, bounded by Telegram's.
 * - `telegramSendPacer`: the process-wide pacer every Bot API call goes through.
 * - `telegramRetryAfterSeconds`: the wait a 429 answer asks for, when it names one.
 * - `reportTelegramDeliveryFailure`: the final failed answer of a send to a chat, handed to the
 *   application's reachability observer.
 *
 * Key construct:
 * - Telegram allows a bot about thirty messages a second in all, one a second to one private
 *   chat and twenty a minute to one group; above that it answers 429 with `retry_after`. One
 *   family never comes near these, a thousand do (answers, progress notices, split long texts
 *   and reminders all count), so every message-sending method waits for a slot in a global
 *   window and in its chat's window before the request, and a 429 pauses every call for the
 *   time Telegram names (5 October 2026); a pause longer than a minute is not waited out, the
 *   429 goes back to the caller.
 * - The private-chat gap is a quarter of a second by default: Telegram tolerates short bursts,
 *   an answer of up to five parts is one, and a whole second between parts was a visible
 *   delay for one family. The three limits are environment settings; an installation serving
 *   a thousand families sets the gap to the full second.
 * - Eve's `callTelegramApi` reports the final answer of every failed call here (24 October 2026). A
 *   send to a chat goes on to the observer the application registers on `globalThis` under
 *   `osinara.telegramDeliveryFailureObserver` (`agent/lib/telegram-reachability/`): every Bot API
 *   call passes Eve's client, so a blocked bot or a removed group is noticed whichever path wrote.
 *   The report carries `startedAt`, the moment the answered attempt was handed to fetch: a proof of
 *   reachability received after it makes that answer stale. The observer is awaited up to 500 ms,
 *   so the next send of the same caller normally sees its mark while a stalled database cannot hold
 *   the answer; its failure is logged and never replaces Telegram's answer. Reads and bot settings
 *   never mark a chat.
 */
const PACED_METHODS = new Set([
  "copyMessage",
  "sendRichMessage",
  "sendRichMessageDraft",
  "editMessageCaption",
  "editMessageMedia",
  "editMessageReplyMarkup",
  "editMessageText",
  // Telegram widget messages (Bot API 10.4 beta) and the bot's edits of their state.
  "editMessageWidgetData",
  "forwardMessage",
  "sendAnimation",
  "sendAudio",
  "sendDocument",
  "sendMediaGroup",
  "sendMessage",
  "sendPhoto",
  "sendSticker",
  "sendVideo",
  "sendVoice",
  "sendWidget",
]);
// Calls whose failure can say the chat itself is gone; reads and bot settings never mark a chat.
const OBSERVED_METHODS = new Set([...PACED_METHODS, "sendChatAction"]);
const DELIVERY_FAILURE_OBSERVER_KEY = Symbol.for("osinara.telegramDeliveryFailureObserver");
// The longest a failed answer waits for the observer before it goes back to the caller.
const DELIVERY_FAILURE_REPORT_TIMEOUT_MS = 500;
const GLOBAL_WINDOW_MS = 1_000;
const GROUP_WINDOW_MS = 60_000;
const RETRY_AFTER_MAX_SECONDS = 60;
const PRUNE_EVERY_ACQUIRES = 1_000;

const SETTING_BOUNDS = {
  TELEGRAM_SEND_GLOBAL_PER_SECOND: { absent: 25, max: 30, min: 1 },
  TELEGRAM_SEND_GROUP_PER_MINUTE: { absent: 20, max: 20, min: 1 },
  TELEGRAM_SEND_PRIVATE_GAP_MS: { absent: 250, max: 5_000, min: 0 },
} as const;

function integerSetting(
  name: keyof typeof SETTING_BOUNDS,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const bounds = SETTING_BOUNDS[name];
  const raw = env[name];
  if (raw === undefined) return bounds.absent;
  const value = Number(raw);
  if (
    !/^\d+$/u.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new Error(
      `AGENT_RUNTIME_TUNING_INVALID: ${name} должно быть целым от ${bounds.min} до ${bounds.max}`,
    );
  }
  return value;
}

/** The pacer limits an installation configured, with Telegram's own as the ceiling. */
export function telegramSendPacerSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Required<Pick<TelegramSendPacerOptions, "globalPerSecond" | "groupPerMinute" | "privateGapMs">> {
  return {
    globalPerSecond: integerSetting("TELEGRAM_SEND_GLOBAL_PER_SECOND", env),
    groupPerMinute: integerSetting("TELEGRAM_SEND_GROUP_PER_MINUTE", env),
    privateGapMs: integerSetting("TELEGRAM_SEND_PRIVATE_GAP_MS", env),
  };
}

export interface TelegramSendPacerOptions {
  /** Messages a second to all chats together; Telegram's limit is about thirty. */
  globalPerSecond?: number;
  /** Messages a minute to one group or channel; Telegram's limit is twenty. */
  groupPerMinute?: number;
  now?: () => number;
  /** Shortest gap between two messages to one private chat; Telegram names one a second and
   * tolerates short bursts. */
  privateGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TelegramSendPacer {
  /**
   * Waits for a slot for this call: its chat's window in that chat's order, then the global
   * window in arrival order. A method that sends nothing takes no slot and only waits out a pause.
   */
  acquire(method: string, body: unknown): Promise<void>;
  /**
   * Pauses every call until `seconds` from now, as a 429 answer asked; false when the wait is
   * longer than the cap, in which case the caller gives the answer back instead of retrying.
   */
  retryAfter(seconds: number): boolean;
  /**
   * Counts a send that went without a slot (the reply to an ephemeral command, which cannot wait)
   * in its chat's and the global windows, so the paced sends after it keep within the limits.
   */
  record(method: string, body: unknown): void;
  /** Waits out the pause, including one extended by another 429 meanwhile. */
  waitForPause(): Promise<void>;
}

function chatKey(body: unknown): { id: string; group: boolean } | null {
  if (typeof body !== "object" || body === null) return null;
  const chatId = (body as { chat_id?: unknown }).chat_id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return null;
  const id = String(chatId);
  // Telegram gives groups, supergroups and channels negative ids; private chats positive ones.
  return { group: id.startsWith("-"), id };
}

export function createTelegramSendPacer(options: TelegramSendPacerOptions = {}): TelegramSendPacer {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const globalPerSecond = options.globalPerSecond ?? 25;
  const groupPerMinute = options.groupPerMinute ?? 20;
  const privateGapMs = options.privateGapMs ?? 250;
  const globalSends: number[] = [];
  const groupSends = new Map<string, number[]>();
  const privateLastSend = new Map<string, number>();
  let pauseUntil = 0;
  // Callers take global slots in arrival order: one waiter at a time computes its wait and
  // sleeps, the next one starts after it, so a steady stream to one chat cannot starve another
  // call (Codex review, 5 October 2026). A chat's own window is waited out first in that chat's
  // own queue: one queue for everything let a group at its twenty a minute hold every other chat
  // for up to a minute (Codex review, 6 November 2026).
  let globalQueue: Promise<unknown> = Promise.resolve();
  const chatQueues = new Map<string, { tail: Promise<void>; waiting: number }>();
  let acquires = 0;

  /** Drops chats that have been quiet for their whole window, so the maps stay bounded. */
  function prune(at: number): void {
    for (const [id, last] of privateLastSend) {
      if (last + privateGapMs <= at) privateLastSend.delete(id);
    }
    for (const [id, sends] of groupSends) {
      pruneSends(sends, GROUP_WINDOW_MS, at);
      if (sends.length === 0) groupSends.delete(id);
    }
  }

  function pruneSends(sends: number[], windowMs: number, at: number): void {
    while (sends.length > 0 && sends[0]! <= at - windowMs) sends.shift();
  }

  function globalWait(at: number): number {
    let wait = Math.max(0, pauseUntil - at);
    pruneSends(globalSends, GLOBAL_WINDOW_MS, at);
    if (globalSends.length >= globalPerSecond)
      wait = Math.max(wait, globalSends[0]! + GLOBAL_WINDOW_MS - at);
    return wait;
  }

  function chatWait(at: number, chat: { id: string; group: boolean }): number {
    if (chat.group) {
      const sends = groupSends.get(chat.id) ?? [];
      pruneSends(sends, GROUP_WINDOW_MS, at);
      return sends.length >= groupPerMinute ? sends[0]! + GROUP_WINDOW_MS - at : 0;
    }
    const last = privateLastSend.get(chat.id);
    return last === undefined ? 0 : last + privateGapMs - at;
  }

  async function waitOut(wait: (at: number) => number): Promise<void> {
    for (;;) {
      const ms = wait(now());
      if (ms <= 0) return;
      await sleep(ms);
    }
  }

  /** The global slot, in arrival order among the calls whose chat is ready. */
  function takeGlobalSlot(): Promise<number> {
    // Only this waiter takes global slots while it holds the queue, so the wait converges.
    const turn = globalQueue.then(async () => {
      // The last check and the reservation run with no await between them: a send counted without
      // a slot (`record`) could otherwise take the last place in between (Codex review,
      // 9 November 2026).
      for (;;) {
        const at = now();
        const wait = globalWait(at);
        if (wait <= 0) {
          globalSends.push(at);
          return at;
        }
        await sleep(wait);
      }
    });
    globalQueue = turn.catch(() => undefined);
    return turn;
  }

  function countChatSend(chat: { id: string; group: boolean } | null, at: number): void {
    if (chat?.group) {
      const sends = groupSends.get(chat.id) ?? [];
      sends.push(at);
      groupSends.set(chat.id, sends);
    } else if (chat) {
      privateLastSend.set(chat.id, at);
    }
    acquires += 1;
    if (acquires % PRUNE_EVERY_ACQUIRES === 0) prune(at);
  }

  async function takeSlot(chat: { id: string; group: boolean } | null): Promise<void> {
    for (;;) {
      // This waiter holds the chat's queue, but a send counted without a slot (`record`) may fill
      // the chat's window while it waits for the global slot: then the global slot goes back and the
      // chat's window is waited out again (Codex review, 9 November 2026).
      if (chat) await waitOut((at) => chatWait(at, chat));
      const at = await takeGlobalSlot();
      if (!chat || chatWait(at, chat) <= 0) {
        countChatSend(chat, at);
        return;
      }
      const index = globalSends.lastIndexOf(at);
      if (index >= 0) globalSends.splice(index, 1);
    }
  }

  return {
    acquire(method, body) {
      // A 429 pauses every call (Codex review, 6 November 2026: typing, file reads and button
      // answers went on during the pause), but only a sending call takes a slot.
      if (!PACED_METHODS.has(method)) return this.waitForPause();
      const chat = chatKey(body);
      const key = chat?.id ?? "";
      const entry = chatQueues.get(key) ?? { tail: Promise.resolve(), waiting: 0 };
      entry.waiting += 1;
      chatQueues.set(key, entry);
      const turn = entry.tail.then(() => takeSlot(chat));
      entry.tail = turn
        .catch(() => undefined)
        .then(() => {
          entry.waiting -= 1;
          if (entry.waiting === 0 && chatQueues.get(key) === entry) chatQueues.delete(key);
        });
      return turn;
    },
    record(method, body) {
      if (!PACED_METHODS.has(method)) return;
      const at = now();
      globalSends.push(at);
      countChatSend(chatKey(body), at);
    },
    retryAfter(seconds) {
      if (seconds > RETRY_AFTER_MAX_SECONDS) return false;
      pauseUntil = Math.max(pauseUntil, now() + seconds * 1_000);
      return true;
    },
    async waitForPause() {
      for (;;) {
        const wait = pauseUntil - now();
        if (wait <= 0) return;
        await sleep(wait);
      }
    },
  };
}

export function telegramRetryAfterSeconds(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const parameters = (body as { parameters?: unknown }).parameters;
  if (typeof parameters !== "object" || parameters === null) return null;
  const seconds = (parameters as { retry_after?: unknown }).retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Hands a failed answer of a send to a chat to the application's observer; never throws. The observer
 * receives `{ body, chatId, method, startedAt, status }` (`TelegramDeliveryFailure` in
 * `agent/lib/telegram-reachability/delivery-failure-observer.ts`); `startedAt` is the epoch millisecond
 * the answered attempt was handed to fetch, after its wait for a slot. The answer is held at most
 * `timeoutMs` (500 ms): a stalled database must not delay a reply Telegram already gave, so a slower
 * observer finishes in the background and its failure is still logged. The types stay inline so the
 * vendored copy carries no whitespace-only lines.
 */
export async function reportTelegramDeliveryFailure(
  method: string,
  requestBody: unknown,
  answer: { readonly body: unknown; readonly ok: boolean; readonly status: number },
  startedAt: number,
  timeoutMs: number = DELIVERY_FAILURE_REPORT_TIMEOUT_MS,
): Promise<void> {
  if (answer.ok || !OBSERVED_METHODS.has(method)) return;
  const chat = chatKey(requestBody);
  const observer = (globalThis as { [key: symbol]: unknown })[DELIVERY_FAILURE_OBSERVER_KEY];
  if (!chat || typeof observer !== "function") return;
  const report = { body: answer.body, chatId: chat.id, method, startedAt, status: answer.status };
  const settled = Promise.resolve()
    .then(() => (observer as (failure: unknown) => unknown)(report))
    .then(
      () => "settled",
      (error: unknown) => {
        console.error(
          JSON.stringify({
            chatId: chat.id,
            code: "AGENT_TELEGRAM_DELIVERY_OBSERVER_FAILED",
            errorName: error instanceof Error ? error.name : "UnknownError",
            method,
          }),
        );
        return "settled";
      },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([settled, timedOut]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    console.error(
      JSON.stringify({
        chatId: chat.id,
        code: "AGENT_TELEGRAM_DELIVERY_OBSERVER_REPORT_TIMEOUT",
        method,
        timeoutMs,
      }),
    );
  }
}

export const telegramSendPacer: TelegramSendPacer = createTelegramSendPacer(
  telegramSendPacerSettings(),
);
