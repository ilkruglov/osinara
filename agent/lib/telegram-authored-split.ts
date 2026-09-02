/**
 * Authored splitting of one model answer into separate Telegram messages.
 *
 * Exports:
 * - `TELEGRAM_ASIDE_DIRECTIVE`: service line the model writes between spoken parts.
 * - `TelegramAuthoredParts`: main answer plus the authored asides.
 * - `splitTelegramAuthoredParts`: applies the paced-message ceiling and nothing else.
 * - `stripTelegramAsideDirectives`: durable projection text without transport directives.
 *
 * Key construct:
 * - Where an answer breaks and how each part reads is the author's decision. The ceiling below
 *   limits only how many paced messages one answer can open; a part longer than the Telegram
 *   transport limit is still split further by the presentation layer, as any answer always was.
 * - The directive is transport syntax and never reaches a person: a whole-line directive splits,
 *   any other occurrence is removed. Fenced and indented code keeps its literal content.
 */
const TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT = 5;

export const TELEGRAM_ASIDE_DIRECTIVE = "<telegram-split>";

// Column zero only: an indented directive belongs to a Markdown code block, not to the transport.
const DIRECTIVE_LINE_PATTERN = new RegExp(`^${TELEGRAM_ASIDE_DIRECTIVE}[ \\t\\r]*$`, "u");
const INLINE_DIRECTIVE_PATTERN = new RegExp(TELEGRAM_ASIDE_DIRECTIVE, "gu");
const FENCE_LINE_PATTERN = /^ {0,3}(?<fence>`{3,})(?<info>.*)$/u;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u;

export interface TelegramAuthoredParts {
  readonly asides: readonly string[];
  readonly main: string;
}

interface FenceState {
  length: number;
}

function nextFenceState(line: string, open: FenceState | null): FenceState | null {
  const match = FENCE_LINE_PATTERN.exec(line);
  if (!match) return open;
  const fence = match.groups?.fence?.length ?? 0;
  const info = match.groups?.info ?? "";
  // A closing fence is at least as long as its opening one and carries no info string.
  if (open) return fence >= open.length && info.trim().length === 0 ? null : open;
  return info.includes("`") ? null : { length: fence };
}

function withoutInlineDirective(line: string): string {
  if (!line.includes(TELEGRAM_ASIDE_DIRECTIVE) || INDENTED_CODE_PATTERN.test(line)) return line;
  return line.replace(INLINE_DIRECTIVE_PATTERN, "").replace(/[ \t]{2,}/gu, " ").trimEnd();
}

function authoredParts(markdown: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let fence: FenceState | null = null;
  for (const line of markdown.split("\n")) {
    const openFence = fence;
    fence = nextFenceState(line, fence);
    if (openFence || fence) {
      current.push(line);
      continue;
    }
    if (DIRECTIVE_LINE_PATTERN.test(line)) {
      parts.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(withoutInlineDirective(line));
  }
  parts.push(current.join("\n"));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function splitTelegramAuthoredParts(markdown: string): TelegramAuthoredParts {
  const parts = authoredParts(markdown);
  const main = parts[0];
  if (main === undefined) return { asides: [], main: "" };
  if (parts.length <= TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT) {
    return { asides: parts.slice(1), main };
  }

  // Nothing the author wrote is dropped: everything past the ceiling joins the last message.
  const delivered = [
    ...parts.slice(0, TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT - 1),
    parts.slice(TELEGRAM_AUTHORED_MESSAGE_MAX_COUNT - 1).join("\n\n"),
  ];
  return { asides: delivered.slice(1), main: delivered[0]! };
}

export function stripTelegramAsideDirectives(markdown: string): string {
  return authoredParts(markdown).join("\n\n");
}
