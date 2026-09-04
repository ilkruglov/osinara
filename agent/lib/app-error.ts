/**
 * Application error contract.
 *
 * Exports:
 * - `AppError`: stable code plus safe Russian user message.
 * - `isAppError`: narrows errors at channel and HTTP boundaries.
 *
 * Key construct:
 * - `isRetryable` is the flag Eve's model-call classifier looks for while walking the cause chain.
 *   Only a failure whose repetition can plausibly succeed may set it.
 */
export class AppError extends Error {
  readonly code: string;

  readonly isRetryable: boolean;

  constructor(code: string, message: string, options?: { readonly isRetryable?: boolean }) {
    super(`${code}: ${message}`);
    this.name = "AppError";
    this.code = code;
    this.isRetryable = options?.isRetryable === true;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
