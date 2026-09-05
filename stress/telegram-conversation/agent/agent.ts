/** Native Eve turns with a deterministic provider; all Telegram/application boundaries stay real. */
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { SESSION_MAX_COMPLETED_TURNS } from "../../../agent/config.js";

export default defineAgent({
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
  model: mockModel(({ lastUserMessage, toolResults, tools }) => {
    const marker = [...(lastUserMessage ?? "").matchAll(/conversation-probe-\d+/gu)].at(-1)?.[0];
    if (!marker) throw new Error("TEST_CURRENT_MESSAGE_MISSING");
    const child = lastUserMessage?.includes(`child:${marker}`) === true;
    if (child && tools.some((tool) => tool.name === "agent" || tool.name === "remember")) {
      throw new Error("TEST_CHILD_ROOT_AUTHORITY_LEAK");
    }
    if (marker === `conversation-probe-${SESSION_MAX_COMPLETED_TURNS + 3}`) throw new Error("TEST_MODEL_FAILURE");
    if (toolResults.at(-1)?.isError) throw new Error(`TEST_WORKSPACE_TOOL_FAILED: ${JSON.stringify(toolResults.at(-1))}`);
    if (!child && [1, SESSION_MAX_COMPLETED_TURNS + 1, SESSION_MAX_COMPLETED_TURNS + 5, SESSION_MAX_COMPLETED_TURNS + 6]
      .some((ordinal) => marker === `conversation-probe-${ordinal}`)) {
      if (!toolResults.some((result) => result.name === "load_skill")) {
        return { toolCalls: [{ name: "load_skill", input: { skill: "pohuy" } }] };
      }
      if (!toolResults.some((result) => result.name === "agent" && JSON.stringify(result.output).includes(`child-${marker}`))) {
        return { toolCalls: [{ name: "agent", input: { message: `child:${marker}` } }] };
      }
    }
    if (!toolResults.some((result) => result.name === "bash" && JSON.stringify(result.output).includes(`BASH:${marker}`))) {
      return { toolCalls: [{ name: "bash", input: { command: `printf 'BASH:${marker}\\n'` } }] };
    }
    if (!toolResults.some((result) => result.name === "probe_workspace" && result.output === marker)) {
      return { toolCalls: [{ name: "probe_workspace", input: { marker } }] };
    }
    return `${child ? "child" : "reply"}-${marker}`;
  }),
  modelContextWindowTokens: 1_000_000,
});
