/**
 * A multipart Bot API upload under the same limits as every call of Eve's client.
 *
 * Export:
 * - `postTelegramMultipart`: posts a form to one Bot API method and returns Telegram's answer.
 *
 * Key construct:
 * - Eve's `callTelegramApi` sends JSON only, so a workspace file and the memory export go out by
 *   their own fetch. They waited for a slot, but a 429 neither paused the other calls nor was tried
 *   again (Codex review, 6 November 2026). The client's rule holds here too: the pause Telegram
 *   names applies to every call, the upload is tried once more after it (Telegram took nothing from
 *   the refused request), and a second 429 pauses the others as well and goes back to the caller.
 */
import {
  telegramRetryAfterSeconds,
  telegramSendPacer,
  type TelegramSendPacer,
} from "eve/channels/telegram";

async function requestedPause(response: Response): Promise<number | null> {
  if (response.status !== 429) return null;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return telegramRetryAfterSeconds(body);
}

export async function postTelegramMultipart(input: {
  chatId: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  form: FormData;
  method: string;
  pacer?: Pick<TelegramSendPacer, "acquire" | "retryAfter" | "waitForPause">;
  timeoutMs: number;
  token: string;
}): Promise<Response> {
  const pacer = input.pacer ?? telegramSendPacer;
  const url = `https://api.telegram.org/bot${input.token}/${input.method}`;
  const attempt = async (): Promise<Response> => {
    await pacer.acquire(input.method, { chat_id: input.chatId });
    return await input.fetch(url, {
      body: input.form,
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  };
  const first = await attempt();
  const pause = await requestedPause(first);
  if (pause === null || !pacer.retryAfter(pause)) return first;
  await pacer.waitForPause();
  const second = await attempt();
  const again = await requestedPause(second);
  if (again !== null) pacer.retryAfter(again);
  return second;
}
