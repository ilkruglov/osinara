/**
 * Eve minute tick of whisper placeholders: removes ones nothing will finish, tells an unanswered
 * author that no answer came, and repeats edits Telegram did not confirm.
 */
import { defineSchedule } from "eve/schedules";

import { sweepWhisperPlaceholders } from "../lib/whisper/whisper-placeholder-sweep.js";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(
      sweepWhisperPlaceholders().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            code: "AGENT_TELEGRAM_WHISPER_SWEEP_FAILED",
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }),
    );
  },
});
