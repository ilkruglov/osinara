/**
 * Removing secrets from diagnostic text before it reaches a log or the model.
 *
 * Export:
 * - `redactSecrets`: hides the given exact secrets, `NAME_TOKEN=value` style assignments, Bearer and
 *   Basic credentials, passwords in URLs and provider-shaped keys (`sk-…`, `pv-…`, `nd-…`, `cf-…`).
 *
 * Key construct:
 * - The installer, the Google Workspace runner and the image clients each had their own patterns;
 *   the image clients missed assignments and URL passwords, the installer missed quoted values and
 *   key-shaped tokens. One set now covers all three. An exact secret shorter than eight characters
 *   is not matched literally: splitting on it would shred ordinary text.
 */
const REDACTED = "[СКРЫТО]";

export function redactSecrets(value: string, exactSecrets: readonly string[] = []): string {
  let text = value;
  for (const secret of exactSecrets) {
    if (secret.length >= 8) text = text.split(secret).join(REDACTED);
  }
  return text
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu,
      `$1=${REDACTED}`,
    )
    .replace(/\b(Bearer|Basic)\s+[^\s)"',;]+/giu, `$1 ${REDACTED}`)
    .replace(/:\/\/([^\s:/]+):([^\s@/]+)@/gu, `://$1:${REDACTED}@`)
    .replace(/\b(?:sk|pv|nd|cf)-[A-Za-z0-9_-]{8,}/gu, REDACTED);
}
