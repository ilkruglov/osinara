/**
 * Sandbox write memo tests.
 *
 * Constructs covered:
 * - Identical skill package bytes count as already written for the same container generation.
 * - A new container generation, changed bytes, an unknown generation and workspace paths never hit.
 * - Staging directory creation is remembered per container generation.
 */
import { describe, expect, it } from "vitest";

import { createSandboxWriteMemo, isSkillPackagePath } from "./sandbox-write-memo.js";

const SKILL_PATH = "/tmp/home/.agents/skills/auto-analyst/SKILL.md";
const CONTENT = new TextEncoder().encode("---\nname: auto-analyst\n---\n");

describe("isSkillPackagePath", () => {
  it.each([
    "/tmp/home/.agents/skills/auto-analyst/SKILL.md",
    "/tmp/home/.agents/skills/imagegen/references/prompt.md",
    "/workspace/skills/policy-finance-analyst/SKILL.md",
  ])("accepts the skill package path %s", (path) => {
    expect(isSkillPackagePath(path)).toBe(true);
  });

  it.each([
    "/workspace/group/report.md",
    "/tmp/home/notes.md",
    "/workspace/personal/.agents/skillset/SKILL.md",
  ])("rejects the workspace path %s", (path) => {
    expect(isSkillPackagePath(path)).toBe(false);
  });
});

describe("createSandboxWriteMemo", () => {
  it("remembers one skill file per container generation", () => {
    const memo = createSandboxWriteMemo();

    expect(memo.hasSkillFile("container-1:2026-09-10T10:00:00Z", SKILL_PATH, CONTENT)).toBe(false);
    memo.rememberSkillFile("container-1:2026-09-10T10:00:00Z", SKILL_PATH, CONTENT);

    expect(memo.hasSkillFile("container-1:2026-09-10T10:00:00Z", SKILL_PATH, CONTENT)).toBe(true);
  });

  // Restricted `$HOME` is a tmpfs: a restarted container carries no skills at all.
  it("forgets everything a restarted or replaced container lost", () => {
    const memo = createSandboxWriteMemo();
    memo.rememberSkillFile("container-1:2026-09-10T10:00:00Z", SKILL_PATH, CONTENT);
    memo.rememberStagingDirectory("container-1:2026-09-10T10:00:00Z");

    expect(memo.hasSkillFile("container-1:2026-09-10T11:30:00Z", SKILL_PATH, CONTENT)).toBe(false);
    expect(memo.hasSkillFile("container-2:2026-09-10T10:00:00Z", SKILL_PATH, CONTENT)).toBe(false);
    expect(memo.hasStagingDirectory("container-1:2026-09-10T11:30:00Z")).toBe(false);
  });

  it("misses on changed bytes, an unknown generation and a workspace path", () => {
    const memo = createSandboxWriteMemo();
    const generation = "container-1:2026-09-10T10:00:00Z";
    memo.rememberSkillFile(generation, SKILL_PATH, CONTENT);
    memo.rememberSkillFile(generation, "/workspace/group/report.md", CONTENT);

    expect(memo.hasSkillFile(generation, SKILL_PATH, new TextEncoder().encode("other"))).toBe(false);
    expect(memo.hasSkillFile(null, SKILL_PATH, CONTENT)).toBe(false);
    expect(memo.hasSkillFile(generation, "/workspace/group/report.md", CONTENT)).toBe(false);
  });

  it("remembers the staging directory only for the generation that got it", () => {
    const memo = createSandboxWriteMemo();

    expect(memo.hasStagingDirectory("container-1:2026-09-10T10:00:00Z")).toBe(false);
    memo.rememberStagingDirectory("container-1:2026-09-10T10:00:00Z");

    expect(memo.hasStagingDirectory("container-1:2026-09-10T10:00:00Z")).toBe(true);
    expect(memo.hasStagingDirectory(null)).toBe(false);
  });
});
