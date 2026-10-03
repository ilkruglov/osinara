/**
 * Load-test agent: the production channel, instructions, hooks, memory and schedules with a
 * deterministic provider that only waits.
 *
 * The model answers every step with text after `LOAD_MODEL_LATENCY_MS` (default 5 s, a typical
 * DeepSeek answer at effort high), so Eve builds and persists real prompts, sessions and events
 * while the run measures the agent process, not the provider.
 */
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const latencyMs = Number(process.env.LOAD_MODEL_LATENCY_MS ?? 5_000);

const model = mockModel(async ({ lastUserMessage }) => {
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
  const marker = [...(lastUserMessage ?? "").matchAll(/load-probe-[\d-]+/gu)].at(-1)?.[0];
  return marker ? `reply-${marker}` : "ok";
});

// AI SDK's mock keeps every call's options (whole prompt and tool schemas) for test assertions.
// Over a load run that was ~170 KB a turn, and the server ended in garbage collection rather than
// turns (3 October 2026); the production model keeps nothing.
interface RecordingMock { doGenerateCalls: unknown[]; doStreamCalls: unknown[] }
const recording = model as unknown as RecordingMock & Record<"doGenerate" | "doStream", (options: unknown) => Promise<unknown>>;
for (const name of ["doGenerate", "doStream"] as const) {
  const call = recording[name];
  recording[name] = async (options) => {
    try {
      return await call(options);
    } finally {
      recording.doGenerateCalls.length = 0;
      recording.doStreamCalls.length = 0;
    }
  };
}

export default defineAgent({
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
  model,
  modelContextWindowTokens: 1_000_000,
});
