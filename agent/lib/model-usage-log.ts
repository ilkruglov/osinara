/**
 * Model usage observability.
 *
 * Exports:
 * - `NormalizedProviderUsage`: cache-aware token counts shared by every wire protocol.
 * - `normalizeProviderUsage`: maps OpenAI Chat Completions, DeepSeek, and Anthropic usage.
 * - `observeModelUsage`: logs the provider-reported usage of one model response.
 * - `formatStepUsageLog`: projects Eve `step.completed` usage next to session identity.
 *
 * Key constructs:
 * - DeepSeek reports cache hits only in provider-specific fields the AI SDK does not surface, so
 *   the raw response is observed at the transport boundary instead of Eve's framework usage.
 * - Streaming bodies pass through byte-for-byte; the observer only reads copied text lines.
 */
export interface NormalizedProviderUsage {
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
  readonly completionTokens: number | null;
  readonly promptTokens: number | null;
  readonly reasoningTokens: number | null;
}

export interface ModelUsageLogContext {
  readonly modelId: string;
  readonly url: string;
}

export type UsageLogger = (line: string) => void;

const SSE_DATA_PREFIX = "data:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeProviderUsage(usage: unknown): NormalizedProviderUsage | null {
  if (!isRecord(usage)) return null;

  const anthropicInput = count(usage.input_tokens);
  if (anthropicInput !== null) {
    const cacheRead = count(usage.cache_read_input_tokens) ?? 0;
    const cacheWrite = count(usage.cache_creation_input_tokens) ?? 0;
    return {
      cacheHitTokens: cacheRead,
      cacheMissTokens: anthropicInput + cacheWrite,
      completionTokens: count(usage.output_tokens),
      promptTokens: anthropicInput + cacheRead + cacheWrite,
      reasoningTokens: null,
    };
  }

  const promptTokens = count(usage.prompt_tokens);
  const completionTokens = count(usage.completion_tokens);
  if (promptTokens === null && completionTokens === null) return null;

  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  const cacheHitTokens = count(usage.prompt_cache_hit_tokens) ?? count(promptDetails.cached_tokens);
  const cacheMissTokens = count(usage.prompt_cache_miss_tokens) ??
    (cacheHitTokens !== null && promptTokens !== null ? promptTokens - cacheHitTokens : null);
  return {
    cacheHitTokens,
    cacheMissTokens,
    completionTokens,
    promptTokens,
    reasoningTokens: count(completionDetails.reasoning_tokens),
  };
}

function usageFromJson(text: string): NormalizedProviderUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? normalizeProviderUsage(parsed.usage) : null;
}

function usageFromSseLine(line: string): NormalizedProviderUsage | null {
  if (!line.startsWith(SSE_DATA_PREFIX)) return null;
  const payload = line.slice(SSE_DATA_PREFIX.length).trim();
  if (payload.length === 0 || payload === "[DONE]") return null;
  return usageFromJson(payload);
}

function emit(
  log: UsageLogger,
  context: ModelUsageLogContext,
  usage: NormalizedProviderUsage,
): void {
  log(JSON.stringify({ code: "AGENT_MODEL_USAGE", modelId: context.modelId, url: context.url, ...usage }));
}

function observeStream(
  body: ReadableStream<Uint8Array>,
  context: ModelUsageLogContext,
  log: UsageLogger,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  // Streaming providers report usage in one late chunk; the last observed value wins.
  let usage: NormalizedProviderUsage | null = null;
  const consume = (text: string, flush: boolean): void => {
    pending += text;
    const lines = pending.split(/\r?\n/u);
    pending = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) usage = usageFromSseLine(line) ?? usage;
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    flush() {
      consume(decoder.decode(), true);
      if (usage !== null) emit(log, context, usage);
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
      consume(decoder.decode(chunk, { stream: true }), false);
    },
  }));
}

export function observeModelUsage(
  response: Response,
  context: ModelUsageLogContext,
  log: UsageLogger = (line) => console.info(line),
): Response {
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return new Response(observeStream(response.body, context, log), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  // Usage is read from a copy so the caller's body stream stays untouched.
  void response.clone().text().then((text) => {
    const usage = usageFromJson(text);
    if (usage !== null) emit(log, context, usage);
  }).catch(() => undefined);
  return response;
}

export interface StepUsageEvent {
  readonly data: {
    readonly finishReason: string;
    readonly sequence?: number;
    readonly stepIndex: number;
    readonly turnId: string;
    readonly usage?: {
      readonly cacheReadTokens?: number;
      readonly costUsd?: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    };
  };
  readonly type: "step.completed";
}

export function formatStepUsageLog(
  event: StepUsageEvent,
  session: { readonly channelKind: string | undefined; readonly sessionId: string },
): string {
  const usage = event.data.usage ?? {};
  return JSON.stringify({
    code: "AGENT_MODEL_STEP",
    channelKind: session.channelKind ?? null,
    finishReason: event.data.finishReason,
    sessionId: session.sessionId,
    stepIndex: event.data.stepIndex,
    turnId: event.data.turnId,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  });
}
