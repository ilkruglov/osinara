/**
 * Formatting-independent reading of the vendored Eve and Workflow code for tests.
 *
 * Exports:
 * - `codeShape`: code without whitespace, parentheses, trailing commas, semicolons before a
 *   closing brace and quote style, so a check written against one formatting matches another.
 * - `topLevelFunction`: the full text of one top-level function of a formatted module.
 *
 * Key construct:
 * - The patch tests were written against minified code; `vendor/` is prettier-formatted since
 *   3 October 2026. Comparing shapes keeps the reviewed snippets as they are without tying the
 *   tests to either layout. It is a presence check, not a parser: parentheses are dropped.
 */
export function codeShape(code: string): string {
  return code
    .replace(/\s+/gu, "")
    .replace(/,([)\]}])/gu, "$1")
    .replace(/;\}/gu, "}")
    .replace(/[()]/gu, "")
    .replace(/'/gu, "\"")
    // A snippet cut after `,` or `;` may stand before a closing brace in the formatted source.
    .replace(/[,;]$/u, "");
}

export function topLevelFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:^|\\n)(?:async )?function\\*? ${name}\\(`, "u"));
  if (start < 0) throw new Error(`AGENT_VENDORED_FUNCTION_MISSING: ${name}`);
  const end = source.indexOf("\n}", start + 1);
  if (end < 0) throw new Error(`AGENT_VENDORED_FUNCTION_UNTERMINATED: ${name}`);
  return source.slice(source[start] === "\n" ? start + 1 : start, end + 2);
}
