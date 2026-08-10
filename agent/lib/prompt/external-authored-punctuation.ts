/**
 * External authored-prompt punctuation normalization.
 *
 * Export:
 * - `simplifyExternalAuthoredPunctuation`: removes typography that primes artificial prose.
 *
 * The function is intentionally limited to application-authored instructions. User messages,
 * memory, history, files, tool results, and exact external data must cross unchanged.
 */
const SPACED_TYPOGRAPHIC_DASH_PATTERN = /[\t ]+[—–][\t ]+/gu;
const TYPOGRAPHIC_DASH_PATTERN = /[—–]/gu;
const GUILLEMET_PATTERN = /[«»]/gu;

export function simplifyExternalAuthoredPunctuation(value: string): string {
  return value
    .replace(SPACED_TYPOGRAPHIC_DASH_PATTERN, ": ")
    .replace(TYPOGRAPHIC_DASH_PATTERN, "-")
    .replace(GUILLEMET_PATTERN, "");
}
