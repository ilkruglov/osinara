/**
 * Runtime definitions for code-reviewed group-grantable skills.
 *
 * Exports:
 * - `GROUP_SAFE_SKILL_DEFINITIONS`: complete dynamic Eve skill packages keyed by stable ID.
 * - `selectGroupSafeSkillDefinitions`: projects an exact validated grant set for Eve.
 * - `selectExternalGroupSafeSkillDefinitions`: same grants with external authored punctuation.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineSkill, type SkillDefinition } from "eve/skills";

import { AppError } from "../app-error.js";
import { simplifyExternalAuthoredPunctuation } from "../prompt/external-authored-punctuation.js";
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

function pohuySkill(readAuthoredText: (relativePath: string) => string): SkillDefinition {
  return defineSkill({
    description:
      "Режим ответов с русским матом: техническая точность и живая инженерная лексика. " +
      "Загружай только по явной просьбе отвечать матом; не используй для публичных текстов, " +
      "документации, кода и коммитов.",
    files: {
      "LICENSE.txt": readAuthoredText("LICENSE.txt"),
      "references/ontologia.md": readAuthoredText("references/ontologia.md"),
      "references/sceny.md": readAuthoredText("references/sceny.md"),
      "references/slovar.md": readAuthoredText("references/slovar.md"),
    },
    license: "MIT, см. LICENSE.txt",
    markdown: readAuthoredText("instructions.md"),
  });
}

export const GROUP_SAFE_SKILL_DEFINITIONS: Readonly<
  Record<GroupSafeSkillName, SkillDefinition>
> = {
  pohuy: pohuySkill(text),
};

const EXTERNAL_GROUP_SAFE_SKILL_DEFINITIONS: Readonly<
  Record<GroupSafeSkillName, SkillDefinition>
> = {
  // Only external sessions receive the authored punctuation rewrite; trusted skills stay byte-exact.
  pohuy: pohuySkill((relativePath) => simplifyExternalAuthoredPunctuation(text(relativePath))),
};

export function selectGroupSafeSkillDefinitions(
  names: ReadonlySet<GroupSafeSkillName>,
): Record<string, SkillDefinition> {
  return Object.fromEntries(
    [...names].map((name) => [name, GROUP_SAFE_SKILL_DEFINITIONS[name]]),
  );
}

export function selectExternalGroupSafeSkillDefinitions(
  names: ReadonlySet<GroupSafeSkillName>,
): Record<string, SkillDefinition> {
  return Object.fromEntries(
    [...names].map((name) => [name, EXTERNAL_GROUP_SAFE_SKILL_DEFINITIONS[name]]),
  );
}
