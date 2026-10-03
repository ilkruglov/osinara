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

export default defineAgent({
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
  model: mockModel(async ({ lastUserMessage }) => {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const marker = [...(lastUserMessage ?? "").matchAll(/load-probe-[\d-]+/gu)].at(-1)?.[0];
    return marker ? `reply-${marker}` : "ok";
  }),
  modelContextWindowTokens: 1_000_000,
});
