/**
 * External-group effective capability instruction tests.
 *
 * Constructs covered:
 * - `externalGroupCapabilityInstructions`: renders exact model-visible effective capabilities.
 * - Action-level memory grants remain granular and do not imply sibling actions.
 */
import { describe, expect, it } from "vitest";

import { externalGroupCapabilityInstructions } from "./external-group-capability-instructions.js";

describe("externalGroupCapabilityInstructions", () => {
  it("includes always-available files and only explicitly allowed application capabilities", () => {
    const markdown = externalGroupCapabilityInstructions(
      new Set(["remember", "manage_memory.undo"]),
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
    const markdown = externalGroupCapabilityInstructions(new Set());

    expect(markdown).toMatch(
      /не вызывай, не предлагай и не утверждай, что можешь использовать другие видимые static descriptors/iu,
    );
  });
});
