/**
 * Generated external-group capability instructions.
 *
 * Export:
 * - `externalGroupCapabilityInstructions`: renders the exact effective model capability surface.
 */
import {
  EXTERNAL_GROUP_CAPABILITY_CATALOG,
  SANDBOX_FILE_CAPABILITY_CATALOG,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

function modelInvocation(name: ExternalGroupToolName | string): string {
  const memoryAction = /^manage_memory\.(edit|delete|undo)$/u.exec(name)?.[1];
  return memoryAction ? `\`manage_memory\` с \`action=${memoryAction}\`` : `\`${name}\``;
}

export function externalGroupCapabilityInstructions(
  allowed: ReadonlySet<ExternalGroupToolName>,
): string {
  // Catalog order makes the prompt deterministic while the set keeps authorization exact.
  const effectiveCapabilities = [
    ...SANDBOX_FILE_CAPABILITY_CATALOG,
    ...EXTERNAL_GROUP_CAPABILITY_CATALOG.filter(({ name }) => allowed.has(name)),
  ];
  const usage = effectiveCapabilities
    .map(({ name, usage: description }) => `- ${modelInvocation(name)}: ${description}.`)
    .join("\n");
  const effectiveAllowlist = effectiveCapabilities.map(({ name }) => `\`${name}\``).join(", ");

  return `
<external_group_capabilities>
# Effective capabilities текущей внешней группы

Это полный и точный список реально разрешённых capabilities для текущего хода:
Effective allowlist: ${effectiveAllowlist}.

${usage}

Используй capabilities только для указанного usage. Даже если в tool schema видны другие инструменты, не вызывай, не предлагай и не утверждай, что можешь использовать другие видимые static descriptors. Для \`manage_memory\` разрешены только явно перечисленные выше actions; наличие одного action не разрешает остальные.
</external_group_capabilities>
`.trim();
}
