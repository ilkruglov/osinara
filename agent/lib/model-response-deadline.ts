/**
 * Deadlines on waiting for the model, not on answering.
 *
 * Exports:
 * - `MODEL_RESPONSE_START_TIMEOUT_MS`, `MODEL_STREAM_IDLE_TIMEOUT_MS`: production limits.
 * - `withResponseDeadlines`: a fetch that fails with `AGENT_MODEL_RESPONSE_TIMEOUT` when the provider
 *   does not start answering in time or a streamed answer stops sending.
 *
 * Key construct:
 * - On 1 October 2026 DeepSeek held requests for up to 900 s («unable to start processing within the
 *   900-second timeout»). A model step that long outlived the queue's call and Workflow's inline
 *   ownership lease (860 s), which re-ran the step and lost its retry. A stalled call now fails
 *   after four minutes, well inside both; Eve classifies the error as recoverable and Workflow
 *   retries the step. A long answer that keeps streaming is never cut: only silence is.
 * - Keep-alive is silence. DeepSeek answers headers at once and then sends SSE comments
 *   (`: keep-alive`) or blank lines while the request waits; they cleared the start timer and kept
 *   restarting the idle one, so a stalled call never ended (Codex review, 6 November 2026). Only a
 *   byte outside a comment line that is not whitespace is an answer: the start timer runs until the
 *   first one, the idle timer restarts only on them.
 * - The deadline aborts with an application error rather than an AbortError, so neither the AI SDK
 *   nor Eve mistakes it for the person cancelling the turn. It errors the body itself as well, so it
 *   holds whatever the provider's stream does with the abort, and no timer outlives the body.
 */
import { AppError } from "./app-error.js";

export const MODEL_RESPONSE_START_TIMEOUT_MS = 4 * 60 * 1000;
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 4 * 60 * 1000;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function responseTimeout(stage: "start" | "stream"): AppError {
  return new AppError(
    "AGENT_MODEL_RESPONSE_TIMEOUT",
    stage === "start"
      ? "Модель не начала отвечать вовремя. Повторите запрос позже"
      : "Модель перестала присылать ответ. Повторите запрос позже",
  );
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const COLON = 0x3a;

/** Tells answer bytes from keep-alive across chunks: SSE comment lines and whitespace are not. */
function createProgressScanner() {
  let atLineStart = true;
  let inComment = false;
  return (chunk: Uint8Array): boolean => {
    let progress = false;
    for (const byte of chunk) {
      if (byte === NEWLINE || byte === CARRIAGE_RETURN) {
        atLineStart = true;
        inComment = false;
        continue;
      }
      if (atLineStart && byte === COLON) inComment = true;
      atLineStart = false;
      if (!inComment && byte !== SPACE && byte !== TAB) progress = true;
    }
    return progress;
  };
}

export function withResponseDeadlines(
  fetchImplementation: Fetch,
  limits: { idleMs: number; startMs: number },
): Fetch {
  return async (input, init) => {
    const deadline = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire: (error: AppError) => void = (error) => deadline.abort(error);
    const arm = (stage: "start" | "stream", ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => expire(responseTimeout(stage)), ms);
    };
    const disarm = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    arm("start", limits.startMs);
    let response: Response;
    try {
      response = await fetchImplementation(input, { ...init, signal });
    } catch (error) {
      disarm();
      throw error;
    }
    if (!response.body) {
      disarm();
      return response;
    }

    const reader = response.body.getReader();
    const isProgress = createProgressScanner();
    signal.addEventListener("abort", disarm, { once: true });
    const watched = new ReadableStream<Uint8Array>({
      start(controller) {
        expire = (error) => {
          disarm();
          deadline.abort(error);
          controller.error(error);
          void reader.cancel(error).catch(() => undefined);
        };
      },
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          disarm();
          controller.error(error);
          return;
        }
        if (chunk.done) {
          disarm();
          controller.close();
          return;
        }
        // The start timer runs until the first answer byte; after it, only answer bytes restart.
        if (isProgress(chunk.value)) arm("stream", limits.idleMs);
        controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        disarm();
        await reader.cancel(reason);
      },
    });
    return new Response(watched, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}
