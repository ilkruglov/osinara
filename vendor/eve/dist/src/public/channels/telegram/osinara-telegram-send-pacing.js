/**
 * Pacing of outbound Telegram Bot API calls under Telegram's limits.
 *
 * Exports:
 * - `createTelegramSendPacer`: a pacer with its own clock, for tests.
 * - `telegramSendPacer`: the process-wide pacer every Bot API call goes through.
 * - `telegramRetryAfterSeconds`: the wait a 429 answer asks for, when it names one.
 *
 * Key construct:
 * - Telegram allows a bot about thirty messages a second in all, one a second to one private
 *   chat and twenty a minute to one group; above that it answers 429 with `retry_after`. One
 *   family never comes near these, a thousand do (answers, progress notices, split long texts
 *   and reminders all count), so every message-sending method waits for a slot in a global
 *   window and in its chat's window before the request, and a 429 pauses every call for the
 *   time Telegram names (5 October 2026).
 */
const PACED_METHODS = new Set([
  "copyMessage",
  "editMessageCaption",
  "editMessageMedia",
  "editMessageReplyMarkup",
  "editMessageText",
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
]);
const GLOBAL_WINDOW_MS = 1_000;
const GROUP_WINDOW_MS = 60_000;
const RETRY_AFTER_MAX_SECONDS = 60;
const ACQUIRE_ROUNDS_MAX = 1_000;

                                           
                                                                                   
                           
                                                                               
                          
                     
                                                                                             
                        
                                        
 

                                    
                                                                                       
                                                        
                                                                           
                                    
                                
 

function chatKey(body         )                                        {
  if (typeof body !== "object" || body === null) return null;
  const chatId = (body                         ).chat_id;
  if (typeof chatId !== "number" && typeof chatId !== "string") return null;
  const id = String(chatId);
  // Telegram gives groups, supergroups and channels negative ids; private chats positive ones.
  return { group: id.startsWith("-"), id };
}

export function createTelegramSendPacer(options                           = {})                    {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms        ) => new Promise      ((resolve) => setTimeout(resolve, ms)));
  const globalPerSecond = options.globalPerSecond ?? 25;
  const groupPerMinute = options.groupPerMinute ?? 20;
  const privateGapMs = options.privateGapMs ?? 1_000;
  const globalSends           = [];
  const groupSends = new Map                  ();
  const privateLastSend = new Map                ();
  let pauseUntil = 0;

  function prune(sends          , windowMs        , at        )       {
    while (sends.length > 0 && sends[0]  <= at - windowMs) sends.shift();
  }

  function waitNeeded(at        , chat                                       )         {
    let wait = Math.max(0, pauseUntil - at);
    prune(globalSends, GLOBAL_WINDOW_MS, at);
    if (globalSends.length >= globalPerSecond) wait = Math.max(wait, globalSends[0]  + GLOBAL_WINDOW_MS - at);
    if (chat?.group) {
      const sends = groupSends.get(chat.id) ?? [];
      prune(sends, GROUP_WINDOW_MS, at);
      if (sends.length >= groupPerMinute) wait = Math.max(wait, sends[0]  + GROUP_WINDOW_MS - at);
    } else if (chat) {
      const last = privateLastSend.get(chat.id);
      if (last !== undefined) wait = Math.max(wait, last + privateGapMs - at);
    }
    return wait;
  }

  return {
    async acquire(method, body) {
      if (!PACED_METHODS.has(method)) return;
      const chat = chatKey(body);
      for (let round = 0; round < ACQUIRE_ROUNDS_MAX; round += 1) {
        const wait = waitNeeded(now(), chat);
        if (wait <= 0) break;
        await sleep(wait);
      }
      const at = now();
      globalSends.push(at);
      if (chat?.group) {
        const sends = groupSends.get(chat.id) ?? [];
        sends.push(at);
        groupSends.set(chat.id, sends);
      } else if (chat) {
        privateLastSend.set(chat.id, at);
      }
    },
    retryAfter(seconds) {
      pauseUntil = Math.max(pauseUntil, now() + Math.min(seconds, RETRY_AFTER_MAX_SECONDS) * 1_000);
    },
    async waitForPause() {
      const wait = pauseUntil - now();
      if (wait > 0) await sleep(wait);
    },
  };
}

export function telegramRetryAfterSeconds(body         )                {
  if (typeof body !== "object" || body === null) return null;
  const parameters = (body                            ).parameters;
  if (typeof parameters !== "object" || parameters === null) return null;
  const seconds = (parameters                             ).retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export const telegramSendPacer                    = createTelegramSendPacer();
