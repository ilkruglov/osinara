/**
 * Runtime definitions for code-reviewed group-grantable skills.
 *
 * Exports:
 * - `GROUP_SAFE_SKILL_DEFINITIONS`: complete dynamic Eve skill packages keyed by stable ID.
 * - `selectGroupSafeSkillDefinitions`: projects an exact validated grant set for Eve.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineSkill, type SkillDefinition } from "eve/skills";

import { AppError } from "../app-error.js";
import type { GroupSafeSkillName } from "./group-skill-catalog.js";

const POHUY_ROOT = resolve("config/group-skills/pohuy");

function text(relativePath: string): string {
  const path = resolve(POHUY_ROOT, relativePath);
  if (!existsSync(path)) {
    throw new AppError(
      "AGENT_GROUP_SKILL_PACKAGE_MISSING",
      `Не найден обязательный файл безопасного skill package: ${relativePath}`,
    );
  }
  return readFileSync(path, "utf8");
}

export const GROUP_SAFE_SKILL_DEFINITIONS: Readonly<
  Record<GroupSafeSkillName, SkillDefinition>
> = {
  pohuy: defineSkill({
    description:
      "Режим ответов с русским матом: техническая точность и живая инженерная лексика. " +
      "Загружай только по явной просьбе отвечать матом; не используй для публичных текстов, " +
      "документации, кода и коммитов.",
    files: {
      "LICENSE.txt": text("LICENSE.txt"),
      "references/ontologia.md": text("references/ontologia.md"),
      "references/sceny.md": text("references/sceny.md"),
      "references/slovar.md": text("references/slovar.md"),
    },
    license: "MIT, см. LICENSE.txt",
    markdown: text("instructions.md"),
  }),
};

export function selectGroupSafeSkillDefinitions(
  names: ReadonlySet<GroupSafeSkillName>,
): Record<string, SkillDefinition> {
  return Object.fromEntries(
    [...names].map((name) => [name, GROUP_SAFE_SKILL_DEFINITIONS[name]]),
  );
}
