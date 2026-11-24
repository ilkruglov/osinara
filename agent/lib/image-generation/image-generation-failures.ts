/**
 * How a failed image generation is settled in the operation ledger and told to the model.
 *
 * Exports:
 * - `settleProviderFailure`: a definitive provider failure (nothing was made) fails the operation,
 *   anything else leaves it ambiguous; the error goes on to the model.
 * - `terminalReservationError`: what a replay of a settled call tells the model. An ambiguous call
 *   may have been billed; a failed one made nothing, and a refusal the model could correct stays
 *   correctable once, as it was the first time.
 * - `correctableInputError`: a refusal the model may correct by changing its call, told the same
 *   way the first time (with its own reason, and the exact field when known) and on a replay of
 *   that call.
 */
import { AppError, isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import type { ImageGenerationReservation } from "./image-generation-operation-repository.js";

/** Failures the model may correct by changing its call: advice, field and the replay's reason. */
const CORRECTABLE = {
  AGENT_IMAGE_EDITING_INPUT_INVALID: {
    correction:
      "Возьми другой исходник и повтори вызов один раз; при новом отказе сообщи пользователю.",
    field: "images",
    reason: "Этот вызов уже отклонён: исходник не подошёл",
  },
  AGENT_IMAGE_GENERATION_REJECTED: {
    correction:
      "Измени prompt или исходник по смыслу отказа и повтори вызов один раз; при новом отказе сообщи пользователю.",
    reason: "Этот вызов уже отклонён: сервис не принял prompt или исходник",
  },
} as const satisfies Readonly<
  Record<string, { correction: string; field?: string; reason: string }>
>;

type CorrectableCode = keyof typeof CORRECTABLE;

const isCorrectable = (code: string): code is CorrectableCode => Object.hasOwn(CORRECTABLE, code);

export function correctableInputError(
  code: CorrectableCode,
  reason?: string,
  field?: string,
): ModelFacingError {
  const entry: { correction: string; field?: string; reason: string } = CORRECTABLE[code];
  const named = field ?? entry.field;
  return new ModelFacingError({
    category: "input",
    code,
    correction: entry.correction,
    ...(named === undefined ? {} : { field: named }),
    reason: reason ?? entry.reason,
    retryable: true,
    sideEffectStatus: "not_started",
  });
}

/** Provider outcomes after which nothing was made: the operation fails instead of staying open. */
const DEFINITIVE_FAILURES = new Set([
  "AGENT_IMAGE_EDITING_INPUT_INVALID",
  "AGENT_IMAGE_GENERATION_CONFIG_INVALID",
  "AGENT_IMAGE_GENERATION_PROVIDER_UNAVAILABLE",
  "AGENT_IMAGE_GENERATION_REJECTED",
]);

export function terminalReservationError(
  reservation: Extract<ImageGenerationReservation, { state: "ambiguous" | "failed" }>,
): AppError {
  if (reservation.state === "ambiguous") {
    return new AppError(
      "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
      "Не удалось подтвердить прошлую генерацию. Не повторяйте её без нового запроса",
    );
  }
  // A failed call is definitive: nothing was made, so the model must not hear the generic "it may
  // have been billed". A refusal it could correct stays correctable once, as it was the first time.
  if (isCorrectable(reservation.errorCode)) return correctableInputError(reservation.errorCode);
  return new ModelFacingError({
    category: "operation",
    code: reservation.errorCode,
    correction:
      "Не повторяйте этот вызов автоматически: картинки нет. Новый вызов делайте только по новой просьбе пользователя.",
    reason: "Прошлая генерация этого вызова завершилась ошибкой",
    retryable: false,
    sideEffectStatus: "not_started",
  });
}

export async function settleProviderFailure(
  operations: {
    markAmbiguous(operationKey: string, errorCode: string): Promise<void>;
    markFailed(operationKey: string, errorCode: string): Promise<void>;
  },
  operationKey: string,
  error: unknown,
): Promise<never> {
  const definitive = isAppError(error) && DEFINITIVE_FAILURES.has(error.code);
  const errorCode = isAppError(error) ? error.code : "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN";
  try {
    if (definitive) await operations.markFailed(operationKey, errorCode);
    else await operations.markAmbiguous(operationKey, errorCode);
  } catch (ledgerError) {
    console.error(
      JSON.stringify({
        code: "AGENT_IMAGE_GENERATION_LEDGER_SETTLEMENT_FAILED",
        error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
        operationKey,
        providerErrorCode: errorCode,
      }),
    );
  }
  if (isAppError(error)) throw error;
  throw new AppError(
    "AGENT_IMAGE_GENERATION_STATUS_UNKNOWN",
    "Не удалось подтвердить результат генерации изображения. Не повторяйте запрос сразу",
  );
}
