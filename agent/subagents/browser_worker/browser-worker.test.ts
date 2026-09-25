/**
 * Browser worker tests.
 *
 * Constructs covered:
 * - The worker is a static declared subagent with its own window and budget; the browser tools
 *   refuse every caller outside a private chat or family group and the memory review.
 * - Its tool surface is the browser, the eyes, and explicit denials of every other built-in.
 * - Past the step budget, or on a malformed step event, the browser tools refuse and ask for the
 *   result.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/model-registry.js", () => ({ browserWorkerModel: { modelId: "worker", provider: "test" } }));

const { default: worker } = await import("./agent.js");
const { default: capabilities, BROWSER_WORKER_DENIED_TOOL_NAMES } = await import("./tools/capabilities.js");
const { BROWSER_WORKER_MAX_MODEL_STEPS } = await import("../../config.js");
const stepEvent = (stepIndex: number) => ({ data: { stepIndex }, type: "step.started" });

function ctx(attributes: Record<string, unknown>, channelKind = "telegram") {
  const caller = { attributes, authenticator: "telegram", principalId: "u", principalType: "user" };
  return { channel: { kind: channelKind }, session: { auth: { current: caller, initiator: caller }, id: "s", turn: { id: "t" } } };
}
const resolveTools = (capabilities as unknown as { events: { "step.started": (e: unknown, c: unknown) => Record<string, unknown> } }).events["step.started"];

describe("browser worker definition", () => {
  it("is a static declared subagent with the worker model: Eve keeps no provider object in a dynamic one", () => {
    const definition = worker as unknown as { description?: string; events?: unknown; model?: { modelId?: string } };
    expect(definition.events).toBeUndefined();
    expect(definition.description).toMatch(/на сайте/u);
    expect(definition.model).toMatchObject({ modelId: "worker" });
  });

  it("declares its context window and a token budget instead of relying on the Gateway catalog", () => {
    const definition = worker as unknown as { compaction?: { modelContextWindowTokens?: number }; limits?: { maxInputTokensPerSession?: number }; modelContextWindowTokens?: number };
    expect(definition.modelContextWindowTokens).toBeGreaterThan(0);
    expect(definition.compaction?.modelContextWindowTokens).toBe(definition.modelContextWindowTokens);
    expect(definition.limits?.maxInputTokensPerSession).toBeGreaterThan(0);
  });
});

describe("browser worker tools", () => {
  it("exposes the browser tools and the eyes, and denies the other built-ins", async () => {
    const surface = resolveTools(stepEvent(0), ctx({ familyId: "f", role: "owner", telegramChatType: "private", userId: "u" }));
    expect(Object.keys(surface).sort()).toEqual([...BROWSER_WORKER_DENIED_TOOL_NAMES, "browser_act", "browser_look", "browser_open", "browser_read", "browser_session", "inspect_workspace_image"].sort());
    expect(surface).not.toHaveProperty("browser_confirm");
    const bash = surface.bash as { execute(input: unknown, ctx: unknown): Promise<unknown> };
    await expect(bash.execute({ command: "ls" }, {})).rejects.toMatchObject({ code: "AGENT_BROWSER_WORKER_TOOL_FORBIDDEN" });
  });

  it("refuses every tool outside a private chat or family group and in the memory review", async () => {
    for (const attributes of [
      { familyId: "f", groupType: "external", role: "external", telegramChatType: "supergroup" },
      { familyId: "f", memoryReviewMode: "background", role: "owner", telegramChatType: "private", userId: "u" },
    ]) {
      const surface = resolveTools(stepEvent(0), ctx(attributes));
      for (const name of ["browser_open", "inspect_workspace_image"]) {
        const tool = surface[name] as { execute(input: unknown, ctx: unknown): Promise<unknown> };
        await expect(tool.execute({}, {})).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
      }
    }
  });

  it("turns the browser tools into refusals past the step budget and on a malformed step", async () => {
    const context = ctx({ familyId: "f", role: "owner", telegramChatType: "private", userId: "u" });
    const last = resolveTools(stepEvent(BROWSER_WORKER_MAX_MODEL_STEPS - 1), context);
    expect(last.browser_look).toBe(resolveTools(stepEvent(0), context).browser_look);
    for (const surface of [resolveTools(stepEvent(BROWSER_WORKER_MAX_MODEL_STEPS), context), resolveTools({}, context)]) {
      const look = surface.browser_look as { execute(input: unknown, ctx: unknown): Promise<unknown> };
      await expect(look.execute({}, {})).rejects.toMatchObject({ code: "AGENT_BROWSER_WORKER_STEP_LIMIT_EXCEEDED" });
      expect(Object.keys(surface).sort()).toEqual([...BROWSER_WORKER_DENIED_TOOL_NAMES, "browser_act", "browser_look", "browser_open", "browser_read", "browser_session", "inspect_workspace_image"].sort());
    }
  });
});
