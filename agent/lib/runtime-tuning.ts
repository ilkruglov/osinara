/**
 * Integer tuning settings read from the environment.
 *
 * Export:
 * - `integerSetting`: the named variable as an integer within bounds, or its default when absent.
 *
 * Key construct:
 * - One installation serves one family on one core, another serves a thousand on a bigger
 *   machine (4 October 2026); what differs between them is a handful of numbers, so each is an
 *   environment variable with the single-family value as the default. A value outside its bounds
 *   or not an integer fails at start instead of running with a guess, as the drain count does.
 */
import { AppError } from "./app-error.js";

export interface IntegerSettingBounds {
  /** Value used when the variable is not set. */
  readonly absent: number;
  readonly min: number;
  readonly max: number;
}

export function integerSetting(
  name: string,
  bounds: IntegerSettingBounds,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[name];
  if (raw === undefined) return bounds.absent;
  const value = Number(raw);
  if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new AppError(
      "AGENT_RUNTIME_TUNING_INVALID",
      `${name} должно быть целым от ${bounds.min} до ${bounds.max}`,
    );
  }
  return value;
}
