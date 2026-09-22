/**
 * Thin client for TypeSafe Jev, the typed-decision model behind browser_task.
 *
 * Exports:
 * - `createJevClient`: one `POST /v1/systemone` per decision, typed answers, stable errors.
 * - `JEV_MODEL`: the model id every request names.
 *
 * Key construct:
 * - Jev returns probabilities, not text. The loop asks one `choice` question over the element
 *   table and, only when a submit-like element was chosen inside a form, one `noul` question
 *   about that element. The spike of 22 сентября 2026 showed the noul is meaningless without
 *   the chosen element named in the state.
 */
import { z } from "zod";

import { ModelFacingError } from "../model-facing-error.js";

export const JEV_MODEL = "jev-latest";
const DEFAULT_BASE_URL = "https://api.typesafe.ai";

export interface JevChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string>; }
export interface JevNoulQuestion { type: "noul"; instructions: string; }
export interface JevQuestions { action: JevChoiceQuestion; final?: JevNoulQuestion; }
export interface JevDecision {
  action: { choice: string; confidence: number; probabilities: Record<string, number> };
  /** Probability that the chosen element submits for good; present only when asked. */
  final: number | null;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}
export interface JevClient {
  decide(state: unknown, questions: JevQuestions, signal?: AbortSignal): Promise<JevDecision>;
}

const responseSchema = z.object({
  answers: z.object({
    action: z.object({
      type: z.literal("choice"),
      choice: z.string(),
      probabilities: z.record(z.string(), z.number()),
      confidence: z.number(),
    }),
    final: z.object({ type: z.literal("noul"), noul: z.number() }).optional(),
  }),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }).optional(),
});

function unavailable(reason: string): ModelFacingError {
  return new ModelFacingError({
    category: "dependency",
    code: "AGENT_JEV_UNAVAILABLE",
    correction: "Повторите шаг один раз; при повторном сбое сообщите пользователю, что сервис решений недоступен.",
    reason,
    retryable: true,
    sideEffectStatus: "not_started",
  });
}

export function createJevClient(input: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }): JevClient {
  const doFetch = input.fetch ?? fetch;
  const url = `${input.baseUrl ?? DEFAULT_BASE_URL}/v1/systemone`;
  return {
    async decide(state, questions, signal) {
      const started = Date.now();
      let response: Response;
      try {
        response = await doFetch(url, {
          body: JSON.stringify({ model: JEV_MODEL, questions, state }),
          headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
          method: "POST",
          signal,
        });
      } catch (error) {
        throw unavailable(`Сервис решений не ответил: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 429 || response.status >= 500) {
        throw unavailable(`Сервис решений вернул статус ${response.status}`);
      }
      if (!response.ok) {
        throw new ModelFacingError({
          category: "operation",
          code: "AGENT_JEV_REQUEST_INVALID",
          correction: "Не повторяйте шаг. Сообщите пользователю о сбое инструмента.",
          reason: `Сервис решений отклонил запрос со статусом ${response.status}`,
          retryable: false,
          sideEffectStatus: "not_started",
        });
      }
      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new ModelFacingError({
          category: "dependency",
          code: "AGENT_JEV_RESPONSE_INVALID",
          correction: "Повторите шаг один раз.",
          reason: "Сервис решений ответил в неожиданной форме",
          retryable: true,
          sideEffectStatus: "not_started",
        });
      }
      const { answers, usage } = parsed.data;
      return {
        action: {
          choice: answers.action.choice,
          confidence: answers.action.confidence,
          probabilities: answers.action.probabilities,
        },
        final: answers.final?.noul ?? null,
        latencyMs: Date.now() - started,
        usage: { inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 },
      };
    },
  };
}
