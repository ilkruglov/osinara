/**
 * Thin client for TypeSafe Jev, the typed-decision model behind the reply gate.
 *
 * Exports:
 * - `createJevClient`: one `POST /v1/systemone` per decision, typed answers, stable errors.
 * - `JEV_MODEL`: the pinned model id; the `jev-latest` alias moves between releases and would
 *   shift calibrated thresholds without a code change.
 * - `JevClientError`: `AGENT_JEV_UNAVAILABLE` (network, timeout, 429, 5xx, 529, after one delayed
 *   retry), `AGENT_JEV_REQUEST_REJECTED` (other 4xx: our request is wrong),
 *   `AGENT_JEV_RESPONSE_INVALID`. Messages carry codes and statuses only, never vendor text.
 *
 * Key constructs:
 * - Jev returns probabilities, never text: a `choice` over named options, a `score` as the
 *   expectation over ordered levels, a `noul` as the probability of "yes". Any mix goes in one
 *   request against the same state, and the answers come back under the caller's keys.
 * - Every request carries its own deadline; the gate runs after delivery and must never hold a
 *   turn for a slow vendor (September 2026: every fifth request hung).
 */
import { z } from "zod";

import { readBoundedBody } from "../bounded-body.js";
import { withRequestTimeout } from "../request-signal.js";

export const JEV_MODEL = "jev-1.13.0";
const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 800;
const RETRY_ATTEMPTS = 2;
const MAX_BODY_BYTES = 1_048_576;

export type JevInstructions = string | readonly string[] | Readonly<Record<string, unknown>>;
export interface JevChoiceQuestion { type: "choice"; instructions: JevInstructions; criteria: Readonly<Record<string, string | null>>; }
export interface JevScoreQuestion { type: "score"; instructions: JevInstructions; criteria: readonly string[]; }
export interface JevNoulQuestion { type: "noul"; instructions: JevInstructions; criteria?: { true?: string; false?: string }; }
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; confidence: number; probabilities: Record<string, number>; score: number };

export interface JevDecision<Keys extends string> {
  answers: Record<Keys, JevAnswer>;
  latencyMs: number;
  /** The model that answered, as the vendor reports it. */
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface JevClient {
  decide<Keys extends string>(
    state: unknown,
    questions: Readonly<Record<Keys, JevQuestion>>,
    signal?: AbortSignal,
  ): Promise<JevDecision<Keys>>;
}

export type JevClientErrorCode = "AGENT_JEV_REQUEST_REJECTED" | "AGENT_JEV_RESPONSE_INVALID" | "AGENT_JEV_UNAVAILABLE";

export class JevClientError extends Error {
  constructor(readonly code: JevClientErrorCode, message: string, readonly status: number | null = null) {
    super(`${code}: ${message}`);
    this.name = "JevClientError";
  }
}

// zod 4 rejects NaN and infinities in `z.number()` itself.
const probabilities = z.record(z.string(), z.number());
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number(), probabilities }),
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({ type: z.literal("score"), confidence: z.number(), probabilities, score: z.number() }),
]);
const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  model: z.string().min(1).max(40),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }).optional(),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createJevClient(input: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Pause before the single retry of an unavailable vendor (429, 5xx, 529, network, timeout). */
  retryDelayMs?: number;
  timeoutMs?: number;
}): JevClient {
  const doFetch = withRequestTimeout(input.fetch ?? fetch, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const url = `${input.baseUrl ?? DEFAULT_BASE_URL}/v1/systemone`;
  const retryDelayMs = input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const payloadOf = (state: unknown, questions: unknown) => JSON.stringify({ model: JEV_MODEL, questions, state });
  // The vendor asks for backoff on 429 and 529; one delayed retry is the whole budget of a
  // measurement that runs after the answer is delivered.
  async function request(payload: string, signal: AbortSignal | undefined): Promise<Response> {
    let last: JevClientError | null = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(retryDelayMs);
      let response: Response;
      try {
        response = await doFetch(url, {
          body: payload,
          headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
          method: "POST",
          signal,
        });
      } catch (error) {
        last = new JevClientError("AGENT_JEV_UNAVAILABLE", error instanceof Error ? error.name : "сетевой сбой");
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        last = new JevClientError("AGENT_JEV_UNAVAILABLE", `HTTP ${response.status}`, response.status);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new JevClientError("AGENT_JEV_REQUEST_REJECTED", `HTTP ${response.status}`, response.status);
      }
      return response;
    }
    throw last ?? new JevClientError("AGENT_JEV_UNAVAILABLE", "нет ответа");
  }
  return {
    async decide(state, questions, signal) {
      const started = Date.now();
      const response = await request(payloadOf(state, questions), signal);
      // A transport break while the body streams is the vendor being unavailable, not a bad format.
      let bytes: Buffer;
      try {
        bytes = await readBoundedBody(response, MAX_BODY_BYTES, () => new JevClientError("AGENT_JEV_RESPONSE_INVALID", "тело ответа больше 1 МиБ", response.status));
      } catch (error) {
        if (error instanceof JevClientError) throw error;
        throw new JevClientError("AGENT_JEV_UNAVAILABLE", "обрыв при чтении ответа", response.status);
      }
      let body: unknown;
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new JevClientError("AGENT_JEV_RESPONSE_INVALID", "тело ответа не JSON", response.status);
      }
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) throw new JevClientError("AGENT_JEV_RESPONSE_INVALID", "неожиданная форма ответа", response.status);
      const expected = Object.keys(questions);
      const missing = expected.filter((key) => !(key in parsed.data.answers));
      if (missing.length > 0) {
        throw new JevClientError("AGENT_JEV_RESPONSE_INVALID", `нет ответов: ${missing.join(", ")}`, response.status);
      }
      return {
        answers: parsed.data.answers as Record<typeof expected[number], JevAnswer>,
        latencyMs: Date.now() - started,
        model: parsed.data.model,
        usage: { inputTokens: parsed.data.usage?.input_tokens ?? 0, outputTokens: parsed.data.usage?.output_tokens ?? 0 },
      };
    },
  };
}
