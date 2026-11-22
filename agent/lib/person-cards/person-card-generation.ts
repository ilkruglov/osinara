/**
 * The model call of a card build and what its failure means.
 *
 * Exports:
 * - `PersonCardGeneration`: the answer's text and token usage.
 * - `generatePersonCard`: one streamed call of the person-card model.
 * - `PersonCardAnswerInterrupted`: a stream error after the answer began.
 * - `ModelFailure`, `describeModelFailure`: the stable code of a failure, whether its outcome is
 *   unclear and whether the provider refused before any work.
 *
 * Key constructs:
 * - Streamed, not one response: the shared transport fails a call that sends nothing for four
 *   minutes (`model-response-deadline.ts`); a whole JSON answer arrives only at its end, so a big
 *   card at effort high would never outlive that. Streamed reasoning keeps the call alive.
 * - Unclear is only what may succeed on the same request: the network (also a body cut mid-stream,
 *   which the SDK wraps as a non-retryable error around a `TypeError`), a timeout, a provider-side
 *   error event, a rate limit the SDK would retry, a stream that ended without finishing. A refusal
 *   before work (`deepseek-errors.ts`) is so only while the answer had not begun. A rejected request, an
 *   exhausted balance, a truncated or filtered answer are definite: another attempt would pay
 *   again for the same result. Only a stream that finished with `stop` is an answer.
 * - The code is the first application code on the error's cause chain (the transport wraps its own
 *   errors in the AI SDK's), else the documented code of the HTTP status the SDK's error carries.
 */
import { APICallError } from "@ai-sdk/provider";
import { streamText, type LanguageModel } from "ai";

import { AppError, isAppError } from "../app-error.js";
import {
  describeDeepSeekHttpError,
  isDeepSeekRefusalBeforeWork,
} from "../deepseek/deepseek-errors.js";
import { personCardModel } from "../model-registry.js";
import { PERSON_CARD_MODEL_TIMEOUT_MILLISECONDS } from "./person-card-config.js";

export interface PersonCardGeneration {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  text: string;
}

export async function generatePersonCard(
  input: { prompt: string; system: string },
  model: LanguageModel = personCardModel,
): Promise<PersonCardGeneration> {
  const result = streamText({
    abortSignal: AbortSignal.timeout(PERSON_CARD_MODEL_TIMEOUT_MILLISECONDS),
    maxRetries: 0,
    model,
    // The SDK's default logs the whole error, which a provider may fill with the prompt: family
    // memory. Errors come through the stream and the build logs codes only.
    onError: () => undefined,
    prompt: input.prompt,
    system: input.system,
  });
  let text = "";
  let answered = false;
  let finish: { finishReason: string; usage: Omit<PersonCardGeneration, "text"> } | null = null;
  for await (const part of result.stream) {
    if (part.type === "text-delta") {
      text += part.text;
      answered = true;
    } else if (ANSWER_PARTS.has(part.type)) answered = true;
    else if (part.type === "error") {
      throw answered ? new PersonCardAnswerInterrupted(part.error) : part.error;
    } else if (part.type === "abort") {
      throw new AppError("AGENT_PERSON_CARD_GENERATION_ABORTED", "Вызов модели прерван");
    } else if (part.type === "finish") {
      finish = {
        finishReason: part.finishReason,
        usage: {
          inputTokens: part.totalUsage.inputTokens ?? null,
          outputTokens: part.totalUsage.outputTokens ?? null,
          reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens ?? null,
        },
      };
    }
  }
  if (finish === null) {
    throw new AppError("AGENT_PERSON_CARD_GENERATION_ABORTED", "Ответ модели оборвался");
  }
  if (finish.finishReason === "length") {
    throw new AppError("AGENT_MODEL_OUTPUT_TRUNCATED", "Ответ модели обрезан по длине");
  }
  if (finish.finishReason === "content-filter") {
    throw new AppError("AGENT_MODEL_OUTPUT_FILTERED", "Ответ модели остановлен фильтром");
  }
  if (finish.finishReason !== "stop") {
    throw new AppError("AGENT_MODEL_OUTPUT_INCOMPLETE", "Модель не завершила ответ");
  }
  return { ...finish.usage, text };
}

/**
 * The model has begun answering. DeepSeek's reasoning tokens (`response.reasoning_text.delta`)
 * become no part at all, but the reasoning item opening before them does (`reasoning-start`): its
 * table names an output item that "starts" (api-docs.deepseek.com/guides/responses_api; a live
 * stream was not recorded). Raw provider events would say it too, at ten times the parts the SDK
 * keeps until the call ends.
 */
const ANSWER_PARTS = new Set(["reasoning-delta", "reasoning-start", "text-start"]);

/**
 * A stream error after the model had begun answering (reasoning counts): the call did work, so it
 * is no refusal before work, whatever the provider's error (its cause) says.
 */
export class PersonCardAnswerInterrupted extends Error {
  constructor(cause: unknown) {
    super("Поток модели оборвался после начала ответа", { cause });
    this.name = "PersonCardAnswerInterrupted";
  }
}

// Retryable HTTP statuses reach the caller as the AI SDK's retryable `APICallError`; these are the
// codes thrown for an outcome that is unclear all the same.
const UNCLEAR_CODES = new Set([
  "AGENT_MODEL_OUTPUT_INCOMPLETE",
  "AGENT_MODEL_RESPONSE_TIMEOUT",
  "AGENT_PERSON_CARD_GENERATION_ABORTED",
]);

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 6) {
    chain.push(current);
    current = typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return chain;
}

/** The SDK's `APICallError`, or the plain object it makes of an error event. */
function hasStatus(entry: unknown): entry is { statusCode: number } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "statusCode" in entry &&
    typeof entry.statusCode === "number"
  );
}

/** A sign anywhere on the chain that the same request may still succeed. */
function retryable(entry: unknown): boolean {
  if (APICallError.isInstance(entry)) return entry.isRetryable;
  if (entry instanceof TypeError) return true; // fetch failed, a body cut mid-stream
  if (entry instanceof Error) return entry.name === "TimeoutError" || entry.name === "AbortError";
  // A provider error event in the stream arrives as a plain object.
  return typeof entry === "object" && entry !== null && "isRetryable" in entry
    ? entry.isRetryable === true
    : false;
}

export interface ModelFailure {
  code: string;
  /** The provider turned the request away before any work: the call cost nothing. */
  refusedBeforeWork: boolean;
  /** The same request may still succeed. */
  unclear: boolean;
}

export function describeModelFailure(error: unknown, fallbackCode: string): ModelFailure {
  const chain = causes(error);
  const answered = chain.some((entry) => entry instanceof PersonCardAnswerInterrupted);
  const appCode = chain.find(isAppError)?.code;
  if (appCode !== undefined) {
    return {
      code: appCode,
      refusedBeforeWork: !answered && isDeepSeekRefusalBeforeWork(appCode),
      unclear: UNCLEAR_CODES.has(appCode),
    };
  }
  // A status the transport passed on (a rate limit, 5xx), or the SDK took from an error event,
  // names the failure; whether to retry is the SDK's call (`insufficient_quota` is a 429 it will
  // not retry).
  const withStatus = chain.find(hasStatus);
  const described =
    withStatus === undefined ? null : describeDeepSeekHttpError(withStatus.statusCode);
  return {
    code: described?.code ?? fallbackCode,
    refusedBeforeWork: !answered && (described?.refusedBeforeWork ?? false),
    unclear: chain.some(retryable),
  };
}
