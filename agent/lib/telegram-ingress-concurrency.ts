/**
 * How many chats the Telegram ingress drains at once.
 *
 * Export:
 * - `telegramIngressMaxConcurrentDrains`: `TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS`, 3 when absent.
 *
 * Key construct:
 * - Each drain holds its chat until the turn reaches a session boundary, so this is the number of
 *   turns the whole bot runs at once. A load run on one core (3 October 2026, `stress/load-families`)
 *   capped at ~30 turns a minute with three drains while the core stayed 83 % idle; 50 families in
 *   flight waited up to six minutes. Within a chat the queue stays FIFO either way (`claimNext`).
 */
import { AppError } from "./app-error.js";

const DEFAULT_DRAINS = 3;
const MAX_DRAINS = 100;

export function telegramIngressMaxConcurrentDrains(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS;
  if (raw === undefined) return DEFAULT_DRAINS;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > MAX_DRAINS) {
    throw new AppError(
      "AGENT_TELEGRAM_INGRESS_CONCURRENCY_INVALID",
      `TELEGRAM_INGRESS_MAX_CONCURRENT_DRAINS должно быть целым от 1 до ${MAX_DRAINS}`,
    );
  }
  return value;
}
