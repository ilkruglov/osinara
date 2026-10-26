/**
 * Automatic memory content safety policy.
 *
 * Exports:
 * - `memoryContentRejectionCode`: rejects secrets and payment credentials before claim writing; the
 *   group journal drops such a message's text with it.
 * - `memoryWriteRejectionCode`: the same plus exact coordinates, for memory writes only: a meeting
 *   point typed into a group stays in its history.
 * - `requireAllowedMemoryContent`: shared fail-fast policy for every manual/automatic writer.
 */
import { AppError } from "./app-error.js";

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u;
const CREDENTIAL_ASSIGNMENT_PATTERN = /(?:api[_ -]?key|access[_ -]?token|secret|password|парол[ья])\s*(?::|=|\s)\s*\S{8,}/iu;
const CVV_PATTERN = /(?:cvv|cvc|код\s+с\s+оборот[а-я]*)\s*[:=]?\s*\d{3,4}(?!\d)/iu;
const ONE_TIME_CODE_PATTERN = /(?:одноразов(?:ый|ого)\s+код|otp|2fa)\s*[:=]?\s*\d{4,8}(?!\d)/iu;
const PAYMENT_CARD_CANDIDATE_PATTERN = /(?:\d[ -]?){13,19}/gu;
// A latitude and a longitude with at least four decimals (about 10 m): a shared location reaches the
// chat as "Геолокация: 55.753900, 37.620800" (26 October 2026), and where a person stood is not a
// fact to keep. Such a pair counts when it is named as a place, or when both numbers are as precise as
// a phone's fix (five decimals or more): exchange rates and model weights with four decimals are not
// places (Codex review, 26 October 2026). Versions (24.8.0) and prices (540.50) never match.
const COORDINATES_PATTERN = /(?<![\d.])(-?\d{1,2}\.(\d{4,}))\s*[,;\s]\s*(-?\d{1,3}\.(\d{4,}))(?![\d.])/gu;
const PLACE_WORDS = /(?:геолокац|координат|широт|долгот|местоположен|мест[оау](?![а-яё])|адрес|точк[аеиу](?![а-яё])|\b(?:gps|lat|lng|lon|location)\b)/iu;
const PLACE_CONTEXT_CHARACTERS = 60;

function hasCoordinates(content: string): boolean {
  for (const match of content.matchAll(COORDINATES_PATTERN)) {
    if (Math.abs(Number(match[1])) > 90 || Math.abs(Number(match[3])) > 180) continue;
    const precise = match[2]!.length >= 5 && match[4]!.length >= 5;
    const before = content.slice(Math.max(0, match.index - PLACE_CONTEXT_CHARACTERS), match.index);
    if (precise || PLACE_WORDS.test(before)) return true;
  }
  return false;
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function memoryContentRejectionCode(content: string): string | null {
  if (PRIVATE_KEY_PATTERN.test(content) || CREDENTIAL_ASSIGNMENT_PATTERN.test(content)) {
    return "AGENT_MEMORY_SECRET_REJECTED";
  }
  if (ONE_TIME_CODE_PATTERN.test(content)) return "AGENT_MEMORY_SECRET_REJECTED";
  if (CVV_PATTERN.test(content)) return "AGENT_MEMORY_PAYMENT_CREDENTIAL_REJECTED";
  const cardCandidates = content.match(PAYMENT_CARD_CANDIDATE_PATTERN) ?? [];
  return cardCandidates.some(luhn) ? "AGENT_MEMORY_PAYMENT_CREDENTIAL_REJECTED" : null;
}

export function memoryWriteRejectionCode(content: string): string | null {
  return memoryContentRejectionCode(content) ?? (hasCoordinates(content) ? "AGENT_MEMORY_LOCATION_REJECTED" : null);
}

export function requireAllowedMemoryContent(content: string): string {
  const rejectionCode = memoryWriteRejectionCode(content);
  if (rejectionCode) {
    throw new AppError(
      "AGENT_MEMORY_CONTENT_FORBIDDEN",
      rejectionCode === "AGENT_MEMORY_LOCATION_REJECTED"
        ? "Координаты нельзя сохранять в долговременной памяти: сохраните адрес или место словами, если человек просил"
        : "Секреты и платёжные данные нельзя сохранять в долговременной памяти",
    );
  }
  return content;
}
