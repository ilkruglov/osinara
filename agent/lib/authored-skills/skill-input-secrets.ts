/**
 * One secret check over everything the model hands `manage_skill`.
 *
 * Export:
 * - `assertNoSecretInSkillInput`: walks the tool input and refuses the first key, token or password
 *   with `AGENT_SKILL_SECRET_REJECTED`, a correctable input error naming the path to the field
 *   (`trials[2].summary`, `protocol.cases[0].files["/workspace/in.txt"]`): nothing has started,
 *   and the same call without that line goes through.
 *
 * Key constructs:
 * - Every string, every number and every object key goes through `containsSecret`: examples,
 *   trials, protocols and notes are stored and read back to the model, selection cases go to
 *   another model. A leaf under a key is also read as its JSON pair by the machine forms, so a
 *   fixture's `{"api_key": "…"}` reads as one even though neither half is a key alone.
 * - A key is checked before the walk descends under it, so a reported path never carries a secret;
 *   a key that is one is reported by its object.
 * - A plain `AppError` with this code reached the model as an operation of unknown outcome
 *   (`model-facing-error.ts` reads the category from the code), and the model gave up instead of
 *   taking the line out; the contract is stated here instead.
 * - The draft rubric (`authored-skill-contract.ts`) still checks the draft texts itself: a rollback
 *   re-reads a stored version that no tool input carries.
 */
import { isRecord } from "../json-value.js";
import { ModelFacingError } from "../model-facing-error.js";
import { containsSecret, isSecretJsonPair } from "../secret-redaction.js";
import { SKILL_SECRET_PROBLEM } from "./authored-skill-contract.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

interface SecretField {
  /** The secret is the name of a field of the object at `path`, not a value. */
  inName: boolean;
  path: string;
}

function childPath(path: string, key: string): string {
  if (!IDENTIFIER.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path === "" ? key : `${path}.${key}`;
}

const isLeaf = (value: unknown): value is number | string =>
  typeof value === "string" || typeof value === "number";

/** The field a secret was found in, or null; depth first, in input order. */
function secretField(value: unknown, path: string): SecretField | null {
  if (isLeaf(value)) return containsSecret(String(value)) ? { inName: false, path } : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = secretField(item, `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (containsSecret(key)) return { inName: true, path };
    const child = childPath(path, key);
    const found = secretField(item, child);
    if (found !== null) return found;
    // The pair only lends a field named like a key its label (speech in the value was read above);
    // other rules over the made-up pair read its quotes as signs («пароль роутера"}») or an escaped
    // line break after `FAL_KEY=` as a value (repeat review, 23 November 2026).
    if (isLeaf(item) && isSecretJsonPair(key, String(item))) {
      return { inName: false, path: child };
    }
  }
  return null;
}

export function assertNoSecretInSkillInput(input: unknown): void {
  const found = secretField(input, "");
  if (found === null) return;
  const field = found.path === "" ? "вход" : found.path;
  throw new ModelFacingError({
    category: "input",
    code: "AGENT_SKILL_SECRET_REJECTED",
    correction:
      "Убери из этого поля строку с ключом, токеном или паролем и повтори вызов; секрет навыку не нужен.",
    field,
    reason: `${found.inName ? `${field} (имя поля)` : field}: ${SKILL_SECRET_PROBLEM}`,
    retryable: true,
    sideEffectStatus: "not_started",
  });
}
