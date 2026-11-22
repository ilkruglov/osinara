/**
 * DeepSeek HTTP error contract (api-docs.deepseek.com/quick_start/error_codes).
 *
 * Export:
 * - `describeDeepSeekHttpError`: stable application code, Russian explanation, retryability and
 *   whether the provider refused before doing any work, for every documented status; undocumented
 *   statuses fall back to the generic transport error.
 * - `isDeepSeekRefusalBeforeWork`: whether a code is such a refusal (a call that cost nothing).
 */
export interface DeepSeekHttpErrorDescription {
  readonly code: string;
  readonly message: string;
  /** The request was turned away before any work: nothing was billed. */
  readonly refusedBeforeWork: boolean;
  readonly retryable: boolean;
}

const DOCUMENTED: Readonly<Record<number, DeepSeekHttpErrorDescription>> = {
  400: {
    code: "AGENT_MODEL_REQUEST_INVALID",
    message: "DeepSeek отклонил формат запроса",
    refusedBeforeWork: true,
    retryable: false,
  },
  401: {
    code: "AGENT_MODEL_API_KEY_INVALID",
    message: "DeepSeek не принял ключ доступа",
    refusedBeforeWork: true,
    retryable: false,
  },
  402: {
    code: "AGENT_MODEL_BALANCE_EXHAUSTED",
    message: "На счёте DeepSeek закончились средства, пополните баланс",
    refusedBeforeWork: true,
    retryable: false,
  },
  422: {
    code: "AGENT_MODEL_PARAMETERS_INVALID",
    message: "DeepSeek отклонил параметры запроса",
    refusedBeforeWork: true,
    retryable: false,
  },
  429: {
    code: "AGENT_MODEL_RATE_LIMITED",
    message: "DeepSeek ограничил частоту запросов, повторите позже",
    refusedBeforeWork: true,
    retryable: true,
  },
  500: {
    code: "AGENT_MODEL_PROVIDER_ERROR",
    message: "Сбой на стороне DeepSeek, повторите позже",
    refusedBeforeWork: false,
    retryable: true,
  },
  503: {
    code: "AGENT_MODEL_PROVIDER_OVERLOADED",
    message: "DeepSeek перегружен, повторите чуть позже",
    refusedBeforeWork: true,
    retryable: true,
  },
};

export function describeDeepSeekHttpError(status: number): DeepSeekHttpErrorDescription | null {
  return DOCUMENTED[status] ?? null;
}

export function isDeepSeekRefusalBeforeWork(code: string): boolean {
  return Object.values(DOCUMENTED).some(
    (description) => description.code === code && description.refusedBeforeWork,
  );
}
