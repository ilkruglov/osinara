/**
 * External-group effective capability instruction tests.
 *
 * Constructs covered:
 * - `externalGroupCapabilityInstructions`: renders exact model-visible effective capabilities.
 * - Action-level memory grants remain granular and do not imply sibling actions.
 * - Skill loading is advertised only for the exact live group grants.
 */
import { describe, expect, it } from "vitest";

import { externalGroupCapabilityInstructions } from "./external-group-capability-instructions.js";

describe("externalGroupCapabilityInstructions", () => {
  it("includes always-available files and only explicitly allowed application capabilities", () => {
    const markdown = externalGroupCapabilityInstructions(
      new Set(["remember", "manage_memory.undo"]),
      new Set(),
    );

    expect(markdown).toContain("`glob`");
    expect(markdown).toContain("`grep`");
    expect(markdown).toContain("`read_file`");
    expect(markdown).toContain("`write_file`");
    expect(markdown).toContain("`remember`");
    expect(markdown).toContain("`manage_memory` с `action=undo`");
    expect(markdown).toContain(
      "Effective allowlist: `glob`, `grep`, `read_file`, `write_file`, `manage_memory.undo`, `remember`.",
    );
    expect(markdown).not.toContain("`manage_memory` с `action=edit`");
    expect(markdown).not.toContain("`manage_memory` с `action=delete`");
    expect(markdown).not.toContain("`search_memories`");
  });

  it("forbids offering any other visible static descriptor", () => {
    const markdown = externalGroupCapabilityInstructions(new Set(), new Set());

    expect(markdown).toMatch(
      /не вызывай, не предлагай и не утверждай, что можешь использовать другие видимые static descriptors/iu,
    );
  });

  it("advertises executable load_skill only with an exact live skill grant", () => {
    const withoutSkills = externalGroupCapabilityInstructions(new Set(), new Set());
    const withPohuy = externalGroupCapabilityInstructions(new Set(), new Set(["pohuy"]));

    expect(withoutSkills).not.toContain("`load_skill`");
    expect(withoutSkills).not.toContain("`pohuy`");
    expect(withPohuy).toContain("`load_skill` с `skill=pohuy`");
    expect(withPohuy).toContain("Effective skill allowlist: `pohuy`.");
  });

  it("marks static trusted-only Google Workspace skills as unavailable externally", () => {
    const markdown = externalGroupCapabilityInstructions(new Set(), new Set());

    expect(markdown).toMatch(/Google Workspace.*не доступны.*внешн/iu);
    expect(markdown).not.toMatch(/`gws-[^`]+`/u);
  });
});
