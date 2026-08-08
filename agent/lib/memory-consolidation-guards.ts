/**
 * Deterministic safety policy for semantic claim consolidation.
 *
 * Exports:
 * - `ConsolidationGuardClaim`: application-owned subject/source projection used by guards.
 * - `duplicateSafety`: rejects duplicate classification across numbers, dates, or negation.
 * - `guardConsolidationDecision`: converts a model relation into an allowed repository action.
 */
import type { MemoryKind } from "./memory-record.js";

export type ConsolidationRelation =
  | "ambiguous"
  | "conflict"
  | "correction"
  | "duplicate"
  | "new"
  | "refinement"
  | "temporal_update";

export interface ConsolidationGuardClaim {
  authorRef: string | null;
  content: string;
  evidenceKind: "explicit" | "firsthand" | "inferred" | "reported";
  kind: MemoryKind;
  subjectRef: string;
}

export type GuardedConsolidationDecision =
  | { action: "ambiguous"; reason: string }
  | { action: "conflict"; reason: string }
  | { action: "duplicate" }
  | { action: "new" }
  | { action: "supersede"; relation: "correction" | "refinement" | "temporal_update" };

const NEGATION_PATTERN = /(?:^|[\s,.:;!?])(не|нет|никогда|нигде|никто|ничего)(?=$|[\s,.:;!?])/giu;
const NUMBER_PATTERN = /\p{N}+(?:[.,]\p{N}+)?/gu;
const DATE_TOKEN_PATTERN = /\b(?:январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|ма[йяею]|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*|сегодня|завтра|вчера)\b/giu;
const EXPLICIT_CORRECTION_PATTERN = /(?:^|[^\p{L}])(?:исправляю|поправка|верно\s+(?:так|будет)|я\s+ошиб(?:ся|лась)|неверно)(?=$|[^\p{L}])/iu;
const MUTABLE_LANGUAGE_PATTERN = /(?:^|[^\p{L}])(?:сейчас|теперь|больше\s+не|перестал\p{L}*|начал\p{L}*|планир\p{L}*|решил\p{L}*)(?=$|[^\p{L}])/iu;
const MODEL_INSTRUCTION_PATTERN = /(?:^|[^\p{L}])(?:игнорир\p{L}*|верни|выбери|инструкц\p{L}*|правил\p{L}*|existing_[0-9A-Za-z_-]+|new_[0-9A-Za-z_-]+)(?=$|[^\p{L}])/iu;
const TOPIC_STOP_WORDS = new Set(["больше", "будет", "котор", "сейчас", "теперь", "этого"]);

function tokens(content: string, pattern: RegExp): string[] {
  return [...content.normalize("NFKC").toLocaleLowerCase("ru-RU").matchAll(pattern)]
    .map((match) => match[0]!.trim())
    .sort();
}

function equalTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function duplicateSafety(
  left: string,
  right: string,
): { allowed: true } | { allowed: false; reason: string } {
  // Values and dates are semantic payload, not formatting; omission on either side is also unsafe.
  if (!equalTokens(tokens(left, NUMBER_PATTERN), tokens(right, NUMBER_PATTERN))) {
    return { allowed: false, reason: "Числовые значения claims различаются" };
  }
  if (!equalTokens(tokens(left, DATE_TOKEN_PATTERN), tokens(right, DATE_TOKEN_PATTERN))) {
    return { allowed: false, reason: "Даты claims различаются" };
  }
  if (!equalTokens(tokens(left, NEGATION_PATTERN), tokens(right, NEGATION_PATTERN))) {
    return { allowed: false, reason: "Значимое отрицание claims различается" };
  }
  return { allowed: true };
}

function sameVerifiedSource(
  existing: ConsolidationGuardClaim,
  proposed: ConsolidationGuardClaim,
): boolean {
  const directKinds = new Set(["explicit", "firsthand"]);
  const bothDirect = directKinds.has(existing.evidenceKind) && directKinds.has(proposed.evidenceKind);
  return existing.authorRef !== null &&
    existing.authorRef === proposed.authorRef &&
    bothDirect;
}

function isMutableClaim(claim: ConsolidationGuardClaim): boolean {
  return claim.kind === "preference" || claim.kind === "episode" ||
    MUTABLE_LANGUAGE_PATTERN.test(claim.content);
}

function topicTokens(content: string): Set<string> {
  return new Set(content.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u)
    .filter((token) => token.length >= 4 && !TOPIC_STOP_WORDS.has(token))
    .map((token) => token.length > 5 ? token.slice(0, 5) : token));
}

function hasTopicContinuity(left: string, right: string): boolean {
  const existing = topicTokens(left);
  return [...topicTokens(right)].some((token) => existing.has(token));
}

export function guardConsolidationDecision(input: {
  existing: ConsolidationGuardClaim;
  proposed: ConsolidationGuardClaim;
  relation: ConsolidationRelation;
}): GuardedConsolidationDecision {
  const { existing, proposed, relation } = input;
  if (existing.subjectRef !== proposed.subjectRef) {
    return { action: "ambiguous", reason: "Claims относятся к разным verified subjects" };
  }
  // Model-control language is not evidence of a changed real-world claim and cannot authorize loss.
  if (MODEL_INSTRUCTION_PATTERN.test(proposed.content) &&
    ["correction", "refinement", "temporal_update"].includes(relation)) {
    return { action: "ambiguous", reason: "Candidate содержит управляющий текст вместо evidence" };
  }
  if (["correction", "refinement", "temporal_update"].includes(relation) &&
    !hasTopicContinuity(existing.content, proposed.content)) {
    return { action: "ambiguous", reason: "Candidate не сохраняет тему существующего claim" };
  }
  if (relation === "new") return { action: "new" };
  if (relation === "ambiguous") {
    return { action: "ambiguous", reason: "Классификатор не доказал безопасную relation" };
  }
  if (relation === "conflict") {
    return { action: "conflict", reason: "Claims взаимоисключающи" };
  }

  // Duplicate is the only relation allowed across independent agreeing sources, but payload guards
  // must first prove that values, dates, and negation did not silently change.
  if (relation === "duplicate") {
    const safety = duplicateSafety(existing.content, proposed.content);
    return safety.allowed
      ? { action: "duplicate" }
      : { action: "ambiguous", reason: safety.reason };
  }

  // Cross-source and reported/direct disagreement is a conflict, never an automatic replacement.
  if (!sameVerifiedSource(existing, proposed)) {
    return { action: "conflict", reason: "Источники claims не совпадают" };
  }
  if (relation === "correction") {
    return EXPLICIT_CORRECTION_PATTERN.test(proposed.content)
      ? { action: "supersede", relation }
      : { action: "conflict", reason: "Stable correction не содержит явного исправления" };
  }
  if (relation === "temporal_update") {
    return isMutableClaim(existing) || isMutableClaim(proposed)
      ? { action: "supersede", relation }
      : { action: "conflict", reason: "Stable claim нельзя заменить временным обновлением" };
  }

  // A refinement must preserve values and polarity; only the same firsthand source may make the
  // previous wording historical without a user decision.
  const safety = duplicateSafety(existing.content, proposed.content);
  return safety.allowed
    ? { action: "supersede", relation: "refinement" }
    : { action: "conflict", reason: safety.reason };
}
