/** Bounded consumption of Eve's durable stream, including opening and cancelling the reader. */
import { AppError } from "./app-error.js";

export interface EveSessionResult {
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<{ type: string }>>;
  id: string;
}

export async function waitForSessionBoundary(
  session: EveSessionResult,
  startIndex: number,
  timeoutMilliseconds: number,
): Promise<number> {
  let reader: ReadableStreamDefaultReader<{ type: string }> | undefined;
  let cancellation: Promise<void> | undefined;
  let timedOut = false;
  let completedCursor: number | undefined;
  let cleanupReported = false;
  let deadlineTimeout: ReturnType<typeof setTimeout> | undefined;

  function cancelReader(): Promise<void> | undefined {
    if (!reader) return;
    const activeReader = reader;
    cancellation ??= activeReader.cancel().finally(() => activeReader.releaseLock());
    return cancellation;
  }

  function reportCleanupFailure(error: unknown): void {
    if (cleanupReported) return;
    cleanupReported = true;
    console.error(JSON.stringify({
      code: "AGENT_TELEGRAM_STREAM_CLEANUP_FAILED",
      eveSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  const consume = async (): Promise<number> => {
    const stream = await session.getEventStream({ startIndex });
    reader = stream.getReader();
    try {
      // Opening may finish after the deadline; close that late reader instead of consuming it.
      if (timedOut) return startIndex;
      let nextEventIndex = startIndex;
      while (true) {
        const event = await reader.read();
        if (event.done) break;
        nextEventIndex += 1;
        if (
          event.value.type === "session.waiting" ||
          event.value.type === "session.completed" ||
          event.value.type === "session.failed"
        ) {
          completedCursor = nextEventIndex;
          return nextEventIndex;
        }
      }
      throw new AppError(
        "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING",
        "Eve завершил поток без подтверждения состояния сессии Telegram",
      );
    } finally {
      try {
        await cancelReader();
      } catch (error) {
        if (completedCursor === undefined) throw error;
        // Cleanup cannot undo an observed turn boundary or lose its durable cursor.
        reportCleanupFailure(error);
      }
    }
  };

  const deadline = new Promise<number>((resolve, reject) => {
    deadlineTimeout = setTimeout(() => {
      timedOut = true;
      if (completedCursor !== undefined) {
        reportCleanupFailure("Stream cancellation exceeded the processing deadline");
        resolve(completedCursor);
      } else {
        reject(new AppError(
          "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT",
          "Eve не сообщил состояние сессии за отведённое время. Отправьте сообщение ещё раз",
        ));
      }
      // consume owns cancellation and its rejection; the queue must not wait for stuck cleanup.
      void cancelReader();
    }, timeoutMilliseconds);
  });
  try {
    return await Promise.race([consume(), deadline]);
  } finally {
    clearTimeout(deadlineTimeout);
  }
}
