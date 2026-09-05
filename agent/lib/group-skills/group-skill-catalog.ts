/**
 * Code-reviewed skills that may be granted to Telegram groups.
 *
 * Exports:
 * - `GROUP_SAFE_SKILL_NAMES`: stable persisted skill identifiers.
 * - `GroupSafeSkillName`: validated catalog name.
 * - `parseGroupSkillAllowlist`: fail-closed persisted-policy parser.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export const SKILL_CATALOG_ROOT = resolve("config/skills");
const installedNames = readdirSync(SKILL_CATALOG_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (installedNames.length === 0 || installedNames.some((name) => !/^[a-z0-9][a-z0-9-]*$/u.test(name))) {
  throw new Error("AGENT_SKILL_CATALOG_INVALID: Каталог установленных скиллов пуст или повреждён");
}
export const GROUP_SAFE_SKILL_NAMES = Object.freeze(installedNames) as readonly [string, ...string[]];

export type GroupSafeSkillName = (typeof GROUP_SAFE_SKILL_NAMES)[number];

// Executable skill dependencies are owner-visible and saved with the group's tool policy.
const BASH_SKILLS = new Set(["agent-browser", "docx", "pdf", "xlsx", "t-invest", "find-docs"]);
export function skillRequiresBash(name: string): boolean { return BASH_SKILLS.has(name); }

export function isGroupSafeSkillName(value: string): value is GroupSafeSkillName {
  return (GROUP_SAFE_SKILL_NAMES as readonly string[]).includes(value);
}

export function parseGroupSkillAllowlist(
  value: unknown,
): ReadonlySet<GroupSafeSkillName> | null {
  if (!Array.isArray(value)) return null;

  // Unknown and duplicate grants indicate corrupt policy rather than a safe partial allowlist.
  const allowed = new Set<GroupSafeSkillName>();
  for (const name of value) {
    if (typeof name !== "string" || !isGroupSafeSkillName(name) || allowed.has(name)) return null;
    allowed.add(name);
  }
  return allowed;
}
