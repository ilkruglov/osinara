/**
 * Code-reviewed skills that may be granted to Telegram groups.
 *
 * Exports:
 * - `GROUP_SAFE_SKILL_NAMES`: stable persisted skill identifiers.
 * - `GroupSafeSkillName`: validated catalog name.
 * - `parseGroupSkillAllowlist`: fail-closed persisted-policy parser.
 */
export const GROUP_SAFE_SKILL_NAMES = ["pohuy"] as const;

export type GroupSafeSkillName = (typeof GROUP_SAFE_SKILL_NAMES)[number];

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
