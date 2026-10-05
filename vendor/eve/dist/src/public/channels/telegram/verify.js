import { timingSafeEqual } from "node:crypto";
import { createLogger } from "#internal/logging.js";
const log = createLogger(`telegram.verify`);
async function resolveTelegramWebhookSecretToken(e) {
  let t = e ?? process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  if (!t) throw Error(`TELEGRAM_WEBHOOK_SECRET_TOKEN is required.`);
  return typeof t == `function` ? await t() : t;
}
async function verifyTelegramRequest(e, t) {
  if (t.webhookVerifier !== void 0) {
    let n = await e.text(),
      r = await t.webhookVerifier(e, n);
    if (!r)
      throw Error(
        `telegramChannel: inbound webhook verifier rejected the request.`,
      );
    return typeof r == `string` ? r : n;
  }
  // Osinara: the secret-token header is checked before the body is read, so an unauthenticated
  // request to the public webhook cannot make the server buffer its body (security review,
  // 5 October 2026).
  let r = await resolveTelegramWebhookSecretToken(t.secretToken),
    i = e.headers.get(`x-telegram-bot-api-secret-token`) ?? ``;
  if (!i)
    throw Error(
      `telegramChannel: inbound request missing Telegram secret-token header.`,
    );
  if (!constantTimeCompare(r, i))
    throw Error(`telegramChannel: inbound request secret-token mismatch.`);
  return await e.text();
}
function constantTimeCompare(t, r) {
  if (t.length !== r.length) return !1;
  try {
    return timingSafeEqual(Buffer.from(t), Buffer.from(r));
  } catch (e) {
    return (log.debug(`timingSafeEqual threw`, { error: e }), !1);
  }
}
export { resolveTelegramWebhookSecretToken, verifyTelegramRequest };
