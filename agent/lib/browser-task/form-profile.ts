/**
 * Form profile for browser_task: one per person, each field bound to domains.
 *
 * Exports:
 * - `parseFormProfile`: validates a stored profile; card and password fields are refused at parse time.
 * - `resolveFieldValue`: the only way a value reaches a page: allowed field, allowed domain, run data first.
 * - `fieldForElement`: maps a visible field label to a profile field name.
 * - `upsertProfileField`, `serializeFormProfile`: the only way a field changes, so Mia never hand-crafts JSON.
 * - `FORBIDDEN_FIELDS`: what never gets filled, whatever the profile or the run says.
 */
import { z } from "zod";

import { AppError } from "../app-error.js";
import type { TableElement } from "./element-table.js";

export interface ProfileField { domains: string[]; value: string; }
export type FormProfile = Record<string, ProfileField>;
export const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(["card", "cardnumber", "cvc", "cvv", "expiry", "pan", "password"]);
const PROFILE_INVALID = "AGENT_BROWSER_TASK_PROFILE_INVALID";

const schema = z.record(
  z.string().min(1).max(64),
  z.object({ domains: z.array(z.string().min(1)).min(1), value: z.string().min(1).max(512) }).strict(),
);

export function parseFormProfile(json: string): FormProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new AppError(PROFILE_INVALID, "Анкета не читается как JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(PROFILE_INVALID, "Анкета не соответствует форме: у каждого поля нужны value и domains");
  }
  for (const field of Object.keys(parsed.data)) {
    if (FORBIDDEN_FIELDS.has(field.toLowerCase())) {
      throw new AppError(PROFILE_INVALID, `Поле ${field} в анкете хранить нельзя`);
    }
  }
  return parsed.data;
}

function domainAllowed(domain: string, rules: readonly string[]): boolean {
  return rules.some((rule) => rule === "*" || domain === rule || domain.endsWith(`.${rule}`));
}

export function resolveFieldValue(input: {
  allowedFields: readonly string[];
  domain: string;
  extraData: Record<string, string>;
  field: string;
  profile: FormProfile;
}): string | null {
  const { field } = input;
  if (FORBIDDEN_FIELDS.has(field.toLowerCase())) return null;
  if (!input.allowedFields.includes(field)) return null;
  const explicit = input.extraData[field];
  if (explicit !== undefined) return explicit;
  const entry = input.profile[field];
  if (!entry || !domainAllowed(input.domain, entry.domains)) return null;
  return entry.value;
}

const LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/телефон|phone|тел\./iu, "phone"],
  [/e-?mail|почт/iu, "email"],
  [/фамили|surname|last name/iu, "surname"],
  [/имя|name/iu, "name"],
];

export function fieldForElement(element: Pick<TableElement, "name" | "role">): string | null {
  for (const [pattern, field] of LABELS) if (pattern.test(element.name)) return field;
  return null;
}

/** Adds or replaces a field. A repeat with the same value only widens the domains; a new value replaces both. */
export function upsertProfileField(
  profile: FormProfile,
  input: { domains: readonly string[]; field: string; value: string },
): FormProfile {
  const field = input.field.trim();
  const value = input.value.trim();
  const domains = [...new Set(input.domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (!field || FORBIDDEN_FIELDS.has(field.toLowerCase())) throw new AppError(PROFILE_INVALID, `Поле ${input.field} в анкете хранить нельзя`);
  if (!value) throw new AppError(PROFILE_INVALID, `Пустое значение для поля ${field}`);
  if (domains.length === 0) throw new AppError(PROFILE_INVALID, `Для поля ${field} не названо ни одного домена`);
  const previous = profile[field];
  const merged = previous && previous.value === value ? [...new Set([...previous.domains, ...domains])] : domains;
  return { ...profile, [field]: { domains: merged, value } };
}

export function serializeFormProfile(profile: FormProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}
