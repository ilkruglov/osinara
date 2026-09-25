/**
 * Browser worker tests.
 *
 * Constructs covered:
 * - The worker exists for a verified private chat or family group and for nobody else: not in an
 *   external group, not for an external caller, not during the memory review.
 * - Its tool surface is the browser, the eyes, and explicit denials of every other built-in.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/model-registry.js", () => ({ browserWorkerModel: { modelId: "worker", provider: "test" } }));

const { default: worker } = await import("./agent.js");
const { default: capabilities, BROWSER_WORKER_DENIED_TOOL_NAMES } = await import("./tools/capabilities.js");

function ctx(attributes: Record<string, unknown>, channelKind = "telegram") {
  const caller = { attributes, authenticator: "telegram", principalId: "u", principalType: "user" };
  return { channel: { kind: channelKind }, session: { auth: { current: caller, initiator: caller }, id: "s", turn: { id: "t" } } };
}
const resolveAgent = (worker as unknown as { events: { "session.started": (e: unknown, c: unknown) => unknown } }).events["session.started"];
const resolveTools = (capabilities as unknown as { events: { "step.started": (e: unknown, c: unknown) => Record<string, unknown> } }).events["step.started"];

describe("browser worker availability", () => {
  it("is offered in the private chat and the family group", () => {
    for (const attributes of [
      { familyId: "f", role: "owner", telegramChatType: "private", userId: "u" },
      { familyId: "f", groupType: "family_private", role: "member", telegramChatType: "supergroup", userId: "u" },
    ]) {
      const agent = resolveAgent({}, ctx(attributes)) as { description?: string } | null;
      expect(agent).not.toBeNull();
      expect(agent!.description).toMatch(/на сайте/u);
    }
  });

  it("is absent in an external group, for an external caller and during the memory review", () => {
    expect(resolveAgent({}, ctx({ familyId: "f", groupType: "external", role: "external", telegramChatType: "supergroup" }))).toBeNull();
    expect(resolveAgent({}, ctx({ familyId: "f", role: "external", telegramChatType: "private" }))).toBeNull();
    expect(resolveAgent({}, ctx({ familyId: "f", memoryReviewMode: "background", role: "owner", telegramChatType: "private", userId: "u" }))).toBeNull();
  });
});

describe("browser worker tools", () => {
  it("exposes the browser tools and the eyes, and denies the other built-ins", async () => {
    const surface = resolveTools({}, ctx({ familyId: "f", role: "owner", telegramChatType: "private", userId: "u" }));
    expect(Object.keys(surface).sort()).toEqual([...BROWSER_WORKER_DENIED_TOOL_NAMES, "browser_act", "browser_look", "browser_open", "browser_read", "browser_session", "inspect_workspace_image"].sort());
    expect(surface).not.toHaveProperty("browser_confirm");
    const bash = surface.bash as { execute(input: unknown, ctx: unknown): Promise<unknown> };
    await expect(bash.execute({ command: "ls" }, {})).rejects.toMatchObject({ code: "AGENT_BROWSER_WORKER_TOOL_FORBIDDEN" });
  });
});
