/**
 * Automatic memory content safety policy.
 *
 * Exports:
 * - `memoryWriteRejectionCode`: rejects secrets and payment credentials by `containsSecret`
 *   (`secret-redaction.ts`): a machine form the journal masks or a secret told in words the journal
 *   keeps no text of; then exact coordinates.
 * - `requireAllowedMemoryContent`: shared fail-fast policy for every manual/automatic writer.
 */
import { AppError } from "./app-error.js";
import { containsSecret } from "./secret-redaction.js";

// A latitude and a longitude with at least four decimals (about 10 m): a shared location reaches the
// chat as "Геолокация: 55.753900, 37.620800" (26 October 2026), and where a person stood is not a
// fact to keep. Such a pair counts when it is named as a place, or when both numbers are as precise as
// a phone's fix (five decimals or more): exchange rates and model weights with four decimals are not
// places (Codex review, 26 October 2026). Versions (24.8.0) and prices (540.50) never match.
const COORDINATES_PATTERN =
  /(?<![\d.])(-?\d{1,2}\.(\d{4,}))\s*[,;\s]\s*(-?\d{1,3}\.(\d{4,}))(?![\d.])/gu;
const PLACE_WORDS =
  /(?:геолокац|координат|широт|долгот|местоположен|мест[оау](?![а-яё])|адрес|точк[аеиу](?![а-яё])|\b(?:gps|lat|lng|lon|location)\b)/iu;
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

export function memoryWriteRejectionCode(content: string): string | null {
  return containsSecret(content)
    ? "AGENT_MEMORY_SECRET_REJECTED"
    : hasCoordinates(content)
      ? "AGENT_MEMORY_LOCATION_REJECTED"
      : null;
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
