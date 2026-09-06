/**
 * Native Eve turns with a deterministic provider; every Telegram and application boundary is real.
 *
 * The script (see evals/conversation.eval.ts): external-group turns alternate a human and another
 * bot and only touch the group workspace; the private turn delegates to a child, runs Bash and
 * probes the personal workspace; the family turn runs Bash and probes the family workspace. One
 * external turn fails inside the model on purpose.
 */
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { SESSION_MAX_COMPLETED_TURNS } from "../../../agent/config.js";

export const EXTERNAL_TURN_COUNT = SESSION_MAX_COMPLETED_TURNS + 4;
export const FAILING_ORDINAL = SESSION_MAX_COMPLETED_TURNS + 3;

function ordinalOf(marker: string): number {
  return Number(marker.slice("conversation-probe-".length));
}

export default defineAgent({
  build: { externalDependencies: ["@workflow/world-postgres"] },
  experimental: { workflow: { world: "@workflow/world-postgres" } },
  model: mockModel(({ lastUserMessage, toolResults, tools }) => {
    const marker = [...(lastUserMessage ?? "").matchAll(/conversation-probe-\d+/gu)].at(-1)?.[0];
    if (!marker) throw new Error("TEST_CURRENT_MESSAGE_MISSING");
    const child = lastUserMessage?.includes(`child:${marker}`) === true;
    // A trusted child inherits the parent's scope but never the root-only tools.
    if (child && tools.some((tool) => tool.name === "remember" || tool.name === "generate_image")) {
      throw new Error("TEST_CHILD_ROOT_AUTHORITY_LEAK");
    }
    if (marker === `conversation-probe-${FAILING_ORDINAL}`) throw new Error("TEST_MODEL_FAILURE");
    const last = toolResults.at(-1);
    if (last?.isError) throw new Error(`TEST_WORKSPACE_TOOL_FAILED: ${JSON.stringify(last)}`);
    const trusted = ordinalOf(marker) > EXTERNAL_TURN_COUNT;
    if (trusted && !child) {
      if (!toolResults.some((result) => result.name === "agent" && JSON.stringify(result.output).includes(`child-${marker}`))) {
        return { toolCalls: [{ name: "agent", input: { message: `child:${marker}` } }] };
      }
      if (!toolResults.some((result) => result.name === "bash" && JSON.stringify(result.output).includes(`BASH:${marker}`))) {
        return { toolCalls: [{ name: "bash", input: { command: `printf 'BASH:${marker}\\n'` } }] };
      }
    }
    if (!toolResults.some((result) => result.name === "probe_workspace" && result.output === marker)) {
      return { toolCalls: [{ name: "probe_workspace", input: { marker } }] };
    }
    return `${child ? "child" : "reply"}-${marker}`;
  }),
  modelContextWindowTokens: 1_000_000,
});
