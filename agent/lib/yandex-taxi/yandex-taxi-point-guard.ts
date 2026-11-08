/**
 * The model's answer to a point it edited after places or suggest.
 *
 * Exports:
 * - `createYandexTaxiPointGuard`: a guard with its own per-turn memory, for tests.
 * - `yandexTaxiPointGuard`: the process-wide instance used by `yandex_taxi`.
 *
 * Key construct:
 * - `AGENT_YANDEX_TAXI_POINT_REF_INVALID` is an input error, and the generic correction of an input
 *   error says to fix the arguments and call again. After Yandex Go refused an order draft on
 *   27 October 2026, the model "fixed" the pickup point itself five times in one turn and twice in
 *   the next; every attempt was refused, and the person waited more than a minute. The first edited
 *   point in a turn now asks for a fresh point from places or suggest; the second stops estimate and
 *   order for the rest of the turn and tells the model to speak to the person.
 */
import { isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";

const MAX_TRACKED_TURNS = 500;
const EDITED_POINT = "AGENT_YANDEX_TAXI_POINT_REF_INVALID";

export function createYandexTaxiPointGuard(maxTurns = MAX_TRACKED_TURNS) {
  const edited = new Map<string, number>();
  return {
    /** The error to give the model: a known edited point gets its own correction, anything else passes. */
    explain(turn: string | null, error: unknown): unknown {
      if (!isAppError(error) || error.code !== EDITED_POINT) return error;
      const reason = error.message.replace(new RegExp(`^${EDITED_POINT}:\\s*`, "u"), "");
      const seen = turn === null ? 1 : (edited.get(turn) ?? 0) + 1;
      if (turn !== null) {
        edited.delete(turn);
        edited.set(turn, seen);
        // Insertion order is the eviction order; old turns never come back.
        for (const old of edited.keys()) {
          if (edited.size <= maxTurns) break;
          edited.delete(old);
        }
      }
      if (seen === 1) {
        return new ModelFacingError({
          category: "input",
          code: EDITED_POINT,
          correction:
            "Точку не правь и не собирай сама: вызови places или suggest заново и передай point из их ответа целиком, без изменений.",
          reason,
          retryable: true,
          sideEffectStatus: "not_started",
        });
      }
      return new ModelFacingError({
        category: "input",
        code: "AGENT_YANDEX_TAXI_POINT_REF_REPEATED",
        correction:
          "Больше не вызывай estimate и order в этом ходе: скажи человеку, что адрес не удалось подтвердить в Яндекс Go, и попроси назвать его заново.",
        reason: `${reason}. Это уже вторая изменённая точка в этом ходе`,
        retryable: false,
        sideEffectStatus: "not_started",
      });
    },
  };
}

export const yandexTaxiPointGuard = createYandexTaxiPointGuard();
