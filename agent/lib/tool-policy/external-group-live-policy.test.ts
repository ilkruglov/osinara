/**
 * Current external-group capability repository tests.
 *
 * Constructs covered:
 * - `loadCurrentExternalGroupCapabilities`: family-scoped, external-only registration lookup.
 * - Missing, retyped, and malformed registrations resolve to deny-all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../database.js", () => ({ database: () => ({ query }) }));

import { loadCurrentExternalGroupCapabilities } from "./external-group-live-policy.js";

const IDENTITY = { familyId: "family-1", groupId: "group-1" };

describe("current external-group capability policy", () => {
  beforeEach(() => {
    query.mockReset();
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
    ["deleted registration", []],
    ["retyped registration excluded by the query", []],
    ["malformed persisted allowlist", [{ tool_allowlist: ["unknown_tool"] }]],
  ])("denies all for a %s", async (_scenario, rows) => {
    query.mockResolvedValue({ rows });

    await expect(loadCurrentExternalGroupCapabilities(IDENTITY)).resolves.toEqual(new Set());
  });
});
