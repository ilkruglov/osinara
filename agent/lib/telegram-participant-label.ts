/**
 * Participant label shown to the model.
 *
 * Exports:
 * - `participantLabel`: «Имя (username)», either part alone, or null.
 *
 * Display names collide: in Ft86 «Ilya» (Ilya_Demchenko) and «Ilya Kruglov» (ilya_kruglov) are both
 * «Илья» to the chat. The prompt tells the model to tell namesakes apart by username, but the
 * timeline and the profile card gave it display names only; now every label it reads carries the
 * username, in the «Имя (username)» form the memory review already writes. The username is shown,
 * never used as identity: identity stays the Telegram user id.
 */
export function participantLabel(displayName: string | null, username: string | null): string | null {
  const name = displayName?.trim() || null;
  const handle = username?.trim().replace(/^@/u, "") || null;
  if (handle === null) return name;
  if (name === null) return handle;
  // Only an exact «(username)» ending or the username itself counts as already labelled: a name that
  // merely contains it («Alice Smith», alice) still needs it spelled out (Codex review).
  const lower = name.toLocaleLowerCase("ru-RU");
  const lowerHandle = handle.toLocaleLowerCase("ru-RU");
  return lower === lowerHandle || lower.endsWith(`(${lowerHandle})`) ? name : `${name} (${handle})`;
}
