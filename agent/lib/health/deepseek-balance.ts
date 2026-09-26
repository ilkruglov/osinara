/**
 * DeepSeek account balance.
 *
 * Exports:
 * - `DeepSeekBalance`: availability and USD total.
 * - `readDeepSeekBalance`: `GET /user/balance`, or null when unreadable or not DeepSeek.
 * - `readConfiguredDeepSeekBalance`: the production reader from the model provider config.
 * - `formatDeepSeekBalance`: the digest or alert line, marked as a warning when the bot is at risk.
 *
 * Key constructs:
 * - The balance is the authoritative spend signal: it counts every process using the key,
 *   including evaluation runs outside the bot, which the bot's own usage logs never see.
 * - Only an installation whose model goes to api.deepseek.com asks; the call never throws,
 *   because the digest and the low-balance alert exist to arrive.
 * - Ported from artkruglov/homka (Apache-2.0) on 26 сентября 2026.
 */
import { modelProviderConfig } from "../model-provider-config.js";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEEPSEEK_BALANCE_TIMEOUT_MS = 10_000;

export interface DeepSeekBalance {
  readonly available: boolean;
  readonly totalUsd: number;
}

export interface DeepSeekBalanceInput {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly provider: string;
}

function unreadable(reason: string): null {
  console.error(JSON.stringify({ code: "AGENT_DEEPSEEK_BALANCE_UNREADABLE", reason }));
  return null;
}

export async function readDeepSeekBalance(input: DeepSeekBalanceInput): Promise<DeepSeekBalance | null> {
  if (input.provider !== "deepseek" || new URL(input.baseUrl).hostname !== "api.deepseek.com") return null;
  if (!input.apiKey) return unreadable("missing_api_key");
  try {
    const response = await (input.fetch ?? globalThis.fetch)(DEEPSEEK_BALANCE_URL, {
      headers: { accept: "application/json", authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(DEEPSEEK_BALANCE_TIMEOUT_MS),
    });
    if (!response.ok) return unreadable(`http_${response.status}`);
    const body = await response.json() as { balance_infos?: unknown; is_available?: unknown };
    const usd = Array.isArray(body.balance_infos)
      ? body.balance_infos.find((entry): entry is { total_balance: string } =>
        typeof entry === "object" && entry !== null &&
        (entry as { currency?: unknown }).currency === "USD" &&
        typeof (entry as { total_balance?: unknown }).total_balance === "string")
      : undefined;
    const total = usd === undefined ? Number.NaN : Number(usd.total_balance);
    if (typeof body.is_available !== "boolean" || !Number.isFinite(total)) return unreadable("malformed");
    return { available: body.is_available, totalUsd: total };
  } catch (error) {
    return unreadable(error instanceof Error ? error.name : "unknown");
  }
}

/** The production reader: the configured provider, its base URL and the model key. */
export async function readConfiguredDeepSeekBalance(): Promise<DeepSeekBalance | null> {
  return await readDeepSeekBalance({
    apiKey: process.env.MODEL_API_KEY,
    baseUrl: modelProviderConfig.agent.transport.baseUrl,
    provider: modelProviderConfig.provider,
  });
}

export function usd(value: number): string {
  const text = Math.abs(value).toFixed(2).replace(".", ",");
  return `${value < 0 ? "−" : ""}${text} $`;
}

/** `warning` marks the two states in which the bot stops answering soon or already has. */
/** `changeUsd` is today's balance minus yesterday's: negative is spend, positive a top-up. */
export function formatDeepSeekBalance(
  balance: DeepSeekBalance | null,
  thresholdUsd: number,
  changeUsd: number | null = null,
): { text: string; warning: boolean } | null {
  if (balance === null) return null;
  if (!balance.available) {
    return { text: `DeepSeek: запросы недоступны, баланс ${usd(balance.totalUsd)}. Бот не может отвечать, пополните счёт.`, warning: true };
  }
  if (balance.totalUsd < thresholdUsd) {
    return { text: `DeepSeek: баланс ${usd(balance.totalUsd)}, ниже порога ${usd(thresholdUsd)}. Пополните счёт, иначе бот перестанет отвечать.`, warning: true };
  }
  const change = changeUsd === null ? "" : changeUsd > 0 ? `, за сутки +${usd(changeUsd)}` : `, за сутки ${usd(changeUsd)}`;
  return { text: `DeepSeek: баланс ${usd(balance.totalUsd)}${change}.`, warning: false };
}
