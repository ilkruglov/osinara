/**
 * Eve dynamic external-group capability instruction tests.
 *
 * Constructs covered:
 * - Dynamic instructions resolve the effective allowlist from verified session auth each turn.
 * - Non-external conversations receive no external capability block.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());

vi.mock("./external-group-live-policy.js", () => ({ loadCurrentExternalGroupCapabilities }));

import externalGroupCapabilities from "../../instructions/external-group-capabilities.js";

describe("dynamic external-group capability instructions", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
  });

  it("returns no capability block outside an external group", async () => {
    const result = await externalGroupCapabilities.events["turn.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: { auth: { current: null, initiator: null }, id: "session-1" },
    });

    expect(result).toBeNull();
  });

  it("renders the exact verified allowlist for an external group", async () => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["manage_memory.edit"]));
    const result = await externalGroupCapabilities.events["turn.started"]?.({}, {
      channel: { kind: "telegram" },
      messages: [],
      session: {
        auth: {
          current: {
            attributes: {
              familyId: "family-1",
              groupId: "group-1",
              groupType: "external_private",
              role: "owner",
              toolAllowlist: ["manage_memory.edit"],
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

    expect(result?.markdown).toContain("`manage_memory` с `action=edit`");
    expect(result?.markdown).not.toContain("`manage_memory` с `action=delete`");
    expect(result?.markdown).not.toContain("`remember`");
  });

  it("omits a capability revoked from the current database policy", async () => {
    const result = await externalGroupCapabilities.events["turn.started"]?.({}, {
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

    expect(result?.markdown).not.toContain("`web_search`");
  });
});
