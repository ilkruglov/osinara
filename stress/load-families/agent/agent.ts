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

// LOAD_TOOL_CALL=bash: the first step of every turn runs one bash command before answering, so the
// sandbox container of each family is created and measured (the runner creates it lazily, on the
// first command; a model that only answers never touches it).
const toolCall = process.env.LOAD_TOOL_CALL ?? "";

const model = mockModel(async ({ lastUserMessage, messages, tools }) => {
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
  // `toolResults` spans the whole prompt, earlier turns included; the command of this turn is
  // the tool message after the latest user message (Codex review, 4 October 2026).
  let lastUser = -1;
  messages.forEach((message, index) => { if (message.role === "user") lastUser = index; });
  const ranThisTurn = messages.slice(lastUser + 1).some((message) => message.role === "tool");
  if (toolCall === "bash" && !ranThisTurn && tools.some((tool) => tool.name === "bash")) {
    return { toolCalls: [{ name: "bash", input: { command: "echo load-probe" } }] };
  }
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
