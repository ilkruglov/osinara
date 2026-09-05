/**
 * `<memory-used>` transport directive: which shown memory records the answer relied on.
 *
 * Export:
 * - `extractMemoryUsedDirective`: strips the directive from model text and returns valid refs.
 *
 * The directive is the model's own claim; the caller bounds it to refs shown in the same turn.
 */
import { MEMORY_REF_PATTERN } from "./model-memory.js";

const MEMORY_USED_DIRECTIVE_PATTERN = /[ \t]*<memory-used>([^<]*)<\/memory-used>[ \t]*/gu;

export function extractMemoryUsedDirective(message: string): { memoryRefs: string[]; message: string } {
  const refs = new Set<string>();
  const stripped = message.replace(MEMORY_USED_DIRECTIVE_PATTERN, (match, body: string, offset: number, whole: string) => {
    for (const candidate of body.split(",")) {
      const ref = candidate.trim();
      if (MEMORY_REF_PATTERN.test(ref)) refs.add(ref);
    }
    // A directive between words keeps one space so the sentence does not glue together.
    const atEnd = offset + match.length >= whole.length;
    const atStart = offset === 0;
    return atEnd || atStart ? "" : " ";
  });
  return { memoryRefs: [...refs], message: stripped.replace(/\n{3,}/gu, "\n\n").trim() };
}
