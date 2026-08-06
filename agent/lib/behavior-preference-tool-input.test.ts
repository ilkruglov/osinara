/**
 * Behavior preference model-input contract tests.
 *
 * Constructs covered:
 * - Machine-visible action, scope, preference, and value enums.
 * - Shared semantic validation before approval and execution.
 * - Explicit safe handling of MiniMax sibling-field materialization.
 * - Complete payload and bounded-correction guidance in the tool description.
 */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { deletePreference, setPreference } = vi.hoisted(() => ({
  deletePreference: vi.fn(),
  setPreference: vi.fn(),
}));

vi.mock("./behavior-preference-repository.js", () => ({
  behaviorPreferenceRepository: { delete: deletePreference, set: setPreference },
}));
vi.mock("./family-context.js", () => ({ requireOwner: vi.fn() }));
vi.mock("./memory-context.js", () => ({
  requireMemoryAuthorization: vi.fn(() => ({ familyId: "family-1", scopes: ["personal"] })),
  requireWritableScope: vi.fn((_: unknown, scope: string) => scope),
}));

import manageBehaviorPreference from "./tools/manage_behavior_preference.js";

const context = { callId: "call-1" } as ToolContext;

function approvalFor(input: Record<string, unknown>) {
  return manageBehaviorPreference.approval!({ toolInput: input } as never);
}

describe("manage_behavior_preference model input", () => {
  beforeEach(() => {
    deletePreference.mockReset();
    deletePreference.mockResolvedValue(true);
    setPreference.mockReset();
  });

  it("publishes required common fields and every enum in an object schema", () => {
    const schema = z.toJSONSchema(manageBehaviorPreference.inputSchema as z.ZodType) as {
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
      type?: string;
    };

    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["action", "preference", "scope"]));
    expect(schema.properties.action?.enum).toEqual(["set", "reset"]);
    expect(schema.properties.scope?.enum).toEqual(["personal", "family", "group"]);
    expect(schema.properties.preference?.enum).toEqual([
      "answer_structure",
      "language",
      "response_length",
      "status_updates",
      "tone",
    ]);
    expect(schema.properties.value?.enum).toEqual([
      "prose",
      "structured",
      "match_user",
      "russian",
      "balanced",
      "concise",
      "detailed",
      "milestones",
      "minimal",
      "formal",
      "neutral",
      "warm",
    ]);
  });

  it("rejects the same invalid reset before HITL and execution", async () => {
    const invalid = { action: "reset", scope: "personal" };

    expect(() => approvalFor(invalid)).toThrowError(
      /AGENT_BEHAVIOR_PREFERENCE_INPUT_INVALID.*preference/u,
    );
    await expect(manageBehaviorPreference.execute(invalid as never, context)).rejects.toThrowError(
      /AGENT_BEHAVIOR_PREFERENCE_INPUT_INVALID.*preference/u,
    );
    expect(deletePreference).not.toHaveBeenCalled();
  });

  it("ignores only the known set-only value when MiniMax materializes it for reset", async () => {
    const input = { action: "reset", preference: "tone", scope: "personal", value: "warm" } as const;

    expect(approvalFor(input)).toBe("user-approval");
    await expect(manageBehaviorPreference.execute(input, context)).resolves.toEqual({ deleted: true });
    expect(deletePreference).toHaveBeenCalledWith(expect.anything(), "personal", "tone");
  });

  it("rejects unpublished fields before approval", () => {
    expect(() => approvalFor({
      action: "reset",
      preference: "tone",
      scope: "personal",
      unexpected: true,
    })).toThrowError(/AGENT_BEHAVIOR_PREFERENCE_INPUT_INVALID.*unexpected/u);
  });

  it("documents all action contracts, enums, and one bounded correction without defaults", () => {
    const description = manageBehaviorPreference.description;

    for (const fragment of [
      "action=set",
      "action=reset",
      "personal | family | group",
      "answer_structure",
      "match_user",
      "balanced",
      "milestones",
      "formal",
      "не более одного раза",
      "Не угадывай",
    ]) expect(description).toContain(fragment);
  });
});
