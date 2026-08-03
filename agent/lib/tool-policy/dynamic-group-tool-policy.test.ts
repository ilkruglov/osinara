/**
 * Eve dynamic external-group tool policy tests.
 *
 * Constructs covered:
 * - `group-tool-policy`: current step-scoped overrides with explicit lookup-failure denial.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());

vi.mock("./external-group-live-policy.js", () => ({ loadCurrentExternalGroupCapabilities }));

import groupToolPolicy from "../../tools/group-tool-policy.js";

describe("dynamic group tool policy", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
  });

  it("returns no overrides outside an external group", async () => {
    const result = await groupToolPolicy.events["step.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: { auth: { current: null, initiator: null }, id: "session-1" },
    });

    expect(result).toBeNull();
  });

  it("returns fail-closed overrides for an external group", async () => {
    const result = await groupToolPolicy.events["step.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: {
        auth: {
          current: {
            attributes: {
              groupType: "external_public",
              role: "external",
              toolAllowlist: [],
            },
            authenticator: "telegram",
            principalId: "telegram:101",
            principalType: "user",
          },
          initiator: null,
        },
        id: "session-1",
      },
    });

    expect(result).toMatchObject({ bash: expect.any(Object), remember: expect.any(Object) });
  });

  it("revokes a capability that is absent from the current database policy", async () => {
    const result = await groupToolPolicy.events["step.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: {
        auth: {
          current: {
            attributes: {
              familyId: "family-1",
              groupId: "group-1",
              groupType: "external_public",
              toolAllowlist: ["web_search"],
            },
            authenticator: "telegram",
            principalId: "telegram:101",
            principalType: "user",
          },
          initiator: null,
        },
        id: "session-1",
      },
    });

    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
    expect(result).toHaveProperty("web_search");
  });

  it("leaves current provider-native web search unoverridden when it is allowed", async () => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["web_search"]));
    const result = await groupToolPolicy.events["step.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: {
        auth: {
          current: {
            attributes: {
              familyId: "family-1",
              groupId: "group-1",
              groupType: "external_public",
              toolAllowlist: ["web_search"],
            },
            authenticator: "telegram",
            principalId: "telegram:101",
            principalType: "user",
          },
          initiator: null,
        },
        id: "session-1",
      },
    });

    expect(result).not.toHaveProperty("web_search");
  });

  it("returns deny-all instead of exposing static tools when live policy lookup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loadCurrentExternalGroupCapabilities.mockRejectedValue(new Error("database unavailable"));
    const result = await groupToolPolicy.events["step.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: {
        auth: {
          current: {
            attributes: {
              familyId: "family-1",
              groupId: "group-1",
              groupType: "external_public",
              toolAllowlist: ["web_search"],
            },
            authenticator: "telegram",
            principalId: "telegram:101",
            principalType: "user",
          },
          initiator: null,
        },
        id: "session-1",
      },
    });

    expect(result).toHaveProperty("web_search");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("AGENT_GROUP_TOOL_POLICY_LOOKUP_FAILED"));
    consoleError.mockRestore();
  });
});
