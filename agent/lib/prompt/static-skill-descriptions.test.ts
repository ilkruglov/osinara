/**
 * Static skill descriptor punctuation tests.
 *
 * Constructs covered:
 * - Every authored SKILL frontmatter description visible in Eve's system prompt.
 * - Skill bodies remain outside this contract because external groups cannot load trusted skills.
 */
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const SKILLS_ROOT = new URL("../../skills/", import.meta.url);

describe("static skill descriptions", () => {
  it("does not advertise typographic dashes or guillemets to external turns", async () => {
    const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
    const descriptions: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markdown = await readFile(new URL(`${entry.name}/SKILL.md`, SKILLS_ROOT), "utf8");
      const frontmatter = /^---\n(?<content>[\s\S]*?)\n---/u.exec(markdown)?.groups?.content;
      if (frontmatter === undefined) {
        throw new Error(`AGENT_SKILL_FRONTMATTER_MISSING: Skill ${entry.name} has no frontmatter`);
      }
      descriptions.push(frontmatter);
    }

    expect(descriptions.join("\n")).not.toMatch(/[—–«»]/u);
  });
});
