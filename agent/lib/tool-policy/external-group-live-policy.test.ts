/**
 * Current external-group capability repository tests.
 *
 * Constructs covered:
 * - `loadCurrentExternalGroupCapabilities`: family-scoped, external-only registration lookup.
 * - Missing, retyped, and malformed registrations fail closed distinctly from an empty allowlist.
 * - `authorizeCurrentExternalGroupCapability`: one locked read decides the capability and every
 *   grant it also requires, so no interleaved policy change can satisfy them separately.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const clientQuery = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());

vi.mock("../database.js", () => ({
  database: () => ({ connect: async () => ({ query: clientQuery, release }), query }),
}));

import { authorizeCurrentExternalGroupCapability, loadCurrentExternalGroupCapabilities } from "./external-group-live-policy.js";

const IDENTITY = { familyId: "family-1", groupId: "group-1" };

describe("current external-group capability policy", () => {
  beforeEach(() => {
    query.mockReset();
    clientQuery.mockReset();
    release.mockReset();
  });

  it("authorizes a capability and the grants it also requires from one locked read", async () => {
    clientQuery.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT") ? { rows: [{ tool_allowlist: ["fetch_telegram_avatars"] }] } : { rows: [] });

    await expect(authorizeCurrentExternalGroupCapability(IDENTITY, "fetch_telegram_avatars", { alsoRequired: ["generate_image"] }))
      .rejects.toMatchObject({ code: "AGENT_GROUP_TOOL_FORBIDDEN" });
    const selects = clientQuery.mock.calls.filter(([sql]) => String(sql).startsWith("SELECT"));
    expect(selects).toHaveLength(1);
    expect(selects[0]![0]).toMatch(/FOR SHARE/u);
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);

    clientQuery.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT") ? { rows: [{ tool_allowlist: ["fetch_telegram_avatars", "generate_image"] }] } : { rows: [] });
    await expect(authorizeCurrentExternalGroupCapability(IDENTITY, "fetch_telegram_avatars", { alsoRequired: ["generate_image"] }))
      .resolves.toBeUndefined();
    expect(clientQuery).toHaveBeenCalledWith("COMMIT");
    // Any one of a list authorizes the capability itself; the required grants are all needed.
    await expect(authorizeCurrentExternalGroupCapability(IDENTITY, ["send_workspace_image", "generate_image"]))
      .resolves.toBeUndefined();
  });

  it("loads the exact allowlist only from the current external registration", async () => {
    query.mockResolvedValue({ rows: [{ tool_allowlist: ["remember", "web_fetch"] }] });

    await expect(loadCurrentExternalGroupCapabilities(IDENTITY)).resolves.toEqual(
      new Set(["remember", "web_fetch"]),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/id = \$1[\s\S]*family_id = \$2[\s\S]*type = 'external'/u),
      ["group-1", "family-1"],
    );
  });

  it.each([
    ["deleted registration", [], "AGENT_GROUP_REGISTRATION_INVALID"],
    ["retyped registration excluded by the query", [], "AGENT_GROUP_REGISTRATION_INVALID"],
    [
      "malformed persisted allowlist",
      [{ tool_allowlist: ["unknown_tool"] }],
      "AGENT_GROUP_TOOL_POLICY_INVALID",
    ],
  ])("fails closed for a %s", async (_scenario, rows, code) => {
    query.mockResolvedValue({ rows });

    await expect(loadCurrentExternalGroupCapabilities(IDENTITY)).rejects.toMatchObject({ code });
  });

  it("preserves a valid current registration with an empty allowlist", async () => {
    query.mockResolvedValue({ rows: [{ tool_allowlist: [] }] });

    await expect(loadCurrentExternalGroupCapabilities(IDENTITY)).resolves.toEqual(new Set());
  });
});
