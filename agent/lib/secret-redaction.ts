/**
 * Secrets in text: machine forms masked in place, a secret told in words hidden with its text.
 *
 * Exports:
 * - `SecretSpan`: which part of a text a found machine form hides.
 * - `strictSecretSpans`: the hidden parts of every machine form in a text.
 * - `journalText`: what the journal keeps and shows of a text: nothing when it tells a password, a
 *   card, a CVV or a one-time code in words, otherwise the text with machine forms masked and their
 *   labels kept («FAL_KEY=[СКРЫТО]»); idempotent, extra spans hide more of the same text. For text
 *   the model reads from the past or from other people: the journal, a reply target, a quote, the
 *   queue.
 * - `containsSecret`: a spoken secret or a machine form, for writers that refuse one (skills, memory);
 *   a template's stand-in (`$FAL_KEY`, `your_key`) is none here, and only here.
 * - `isSecretJsonPair`: a field and its value that read as a key in JSON, for structured input.
 * - `redactSecrets`: logs: the given exact secrets, machine and lenient forms.
 *
 * Key constructs:
 * - Machine forms (provider keys `sk-`, `cfat_` and fal's `id:secret`, Telegram bot tokens, Bearer
 *   tokens, PEM keys, passwords in URLs, `NAME_KEY=` assignments, JSON `"api_key": "…"`) have a
 *   clear value to cut out.
 *   Speech has none: three rounds of review found a new way to leave a spoken password half visible,
 *   so a spoken secret hides the whole text, as the journal did before 22 November 2026 (owner).
 * - The spoken rule is the old memory policy's: a password label with a colon or an equals sign and
 *   any word of eight characters; after a bare space only a word with a digit or a sign once the
 *   sentence's own punctuation is cut (owner, 22 November 2026: «пароль администратора» is speech);
 *   a Luhn-valid card; CVV; a one-time code. It only answers yes or no, so it needs no bounds.
 * - Lenient forms (any-case assignments with any value, `Basic`, `pv-`/`nd-`/`cf-`) reach only
 *   logs, where a false mask costs nothing.
 * - Every pattern runs in linear time: shapes start only where a run starts (a `\b` anchor started at
 *   every dash of `a-a-…` and rescanned its tail, 9 s), whitespace is split one way only, an
 *   assignment's value stops at `=` and `:` so no later label rereads it, and a word value is read
 *   whole once through a captured lookahead, never shortened again.
 * - An exact secret shorter than eight characters is not matched literally: splitting on it would
 *   shred ordinary text.
 */
export interface SecretSpan {
  end: number;
  start: number;
}

interface SecretShape {
  /** Optional check of the hidden value the pattern alone cannot express. */
  accept?: (value: string) => boolean;
  /** Global; a `value` group, when present, is the tail of the match and the only part hidden. */
  pattern: RegExp;
  /** A value no template stands in for: a private key's body. */
  literal?: true;
  /** A free word may end a sentence: its trailing comma, full stop or semicolon stays visible. */
  sentence?: true;
  strict: boolean;
}

const MASK = "[СКРЫТО]";
/**
 * Where a label may start: where a run of word characters starts, the underscores that open it
 * (Markdown italics, `_FAL_KEY=…_`) taken into the match. Never inside a run, so `A_A_A…` is read
 * once, not from every underscore (repeat review, 23 November 2026); a lookbehind over those
 * underscores reread the run from each of them, 1.4 s for 64 000 (narrow final review).
 */
const RUN_START = String.raw`(?<![A-Za-z0-9_])_*`;
const MASK_PATTERN = String.raw`\[СКРЫТО\]`;
const SENTENCE_PUNCTUATION = ".,;";
const NOT_MASK = `(?!${MASK_PATTERN})`;
// A quoted literal's body on one line, up to its own quote: the other quote and an escaped
// character belong to it (`"O'Brien12345"` and `"abc\"def"` showed their tail, repeat review,
// 23 November 2026). The two branches never overlap, so the body is read one way only.
const QUOTED_BODY = String.raw`(?:(?!\k<q>)[^\\\n]|\\[^\n])`;
// An assignment's value: a quoted literal, or a whole word without brackets, quotes, `=` or `:`
// that no opening bracket follows (the lookahead takes the word once; a shorter word is never
// tried). Base64 padding may close the word.
const QUOTED_VALUE = String.raw`(?<q>["'])${NOT_MASK}${QUOTED_BODY}{8,}\k<q>`;
const WORD_VALUE = String.raw`(?=(?<word>[^\s()[\]{}<>"'«»\x60=:]{8,}=*))\k<word>(?![([{<])`;
const ASSIGNED_VALUE = String.raw`(?<value>${QUOTED_VALUE}|${WORD_VALUE})`;
/**
 * A fal key: an id, a colon and 32 hex characters of secret. It starts only where a run of id
 * characters starts and ends where the hex does: an underscore after it is Markdown, not the key.
 */
const FAL_KEY = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}:[0-9a-f]{32}(?![A-Za-z0-9])/gu;
/**
 * A Telegram bot token: the bot's id, a colon and the secret. An assignment's word stops at the
 * colon (a colon inside it made `A_TOKEN:A_TOKEN:…` quadratic), and `BOT_TOKEN=` hid only the id
 * (repeat review, 23 November 2026); this form takes the token whole, with or without a label,
 * after a colon and after `bot` as Bot API addresses write it (`/bot123456:ABC…/getMe`), and after
 * `_` or `-` (Markdown italics). A number and a UUID is an id, not a token.
 */
const BOT_TOKEN =
  /(?:(?<=(?<![A-Za-z0-9])bot)|(?<![A-Za-z0-9]))\d{6,12}:(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9]|-[A-Za-z0-9]))[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/giu;

// `"api_key": "…"`: JSON and Python dictionaries.
const JSON_SECRET_PAIR: SecretShape = {
  pattern: new RegExp(
    String.raw`(?<q>["'])[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd)\k<q>\s*:\s*\k<q>(?<value>${NOT_MASK}${QUOTED_BODY}{8,})(?=\k<q>)`,
    "giu",
  ),
  strict: true,
};

const hasLettersAndDigits = (value: string): boolean => /\p{L}/u.test(value) && /\d/u.test(value);

const SHAPES: readonly SecretShape[] = [
  { pattern: FAL_KEY, strict: true },
  { pattern: BOT_TOKEN, strict: true },
  { pattern: /(?<![A-Za-z0-9])(?:sk-|cfat_)[A-Za-z0-9_-]{8,}/gu, strict: true },
  {
    pattern: new RegExp(String.raw`${RUN_START}Bearer\s+(?<value>[A-Za-z0-9._~+/-]{16,}=*)`, "giu"),
    sentence: true,
    strict: true,
  },
  {
    pattern: new RegExp(
      String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?<value>${NOT_MASK}[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$))`,
      "gu",
    ),
    literal: true,
    strict: true,
  },
  // `scheme://user:password@host`, the user may be empty; the value ends at the last `@` of the
  // authority, as a URL parser reads it: a password may hold `@` itself.
  {
    pattern: new RegExp(
      String.raw`:\/\/[^\s:/]*:(?<value>(?!${MASK_PATTERN}@)[^\s/?#]+)(?=@[^\s@/?#]*(?:[\s/?#]|$))`,
      "gu",
    ),
    strict: true,
  },
  JSON_SECRET_PAIR,
  // Environment assignments on one line: `NAME_KEY=…`, and `NAME_TOKEN`, `NAME_SECRET`,
  // `NAME_PASSWORD` with `=` or `:`.
  {
    pattern: new RegExp(
      String.raw`${RUN_START}[A-Z][A-Z0-9_]*(?:_KEY[ \t]*=|(?:TOKEN|SECRET|PASSWORD)[ \t]*[:=])[ \t]*${ASSIGNED_VALUE}`,
      "gu",
    ),
    sentence: true,
    strict: true,
  },
  // Any `*_key` in any case, only with a value of letters and digits.
  {
    accept: hasLettersAndDigits,
    pattern: new RegExp(
      String.raw`${RUN_START}[A-Za-z][A-Za-z0-9_]*_key[ \t]*[:=][ \t]*(?<value>${WORD_VALUE})`,
      "giu",
    ),
    sentence: true,
    strict: true,
  },
  {
    pattern: new RegExp(
      String.raw`${RUN_START}[A-Z][A-Z0-9_]*(?:_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)\s*[:=]\s*(?<value>"[^"]*"|'[^']*'|[^\s,}]+)`,
      "giu",
    ),
    sentence: true,
    strict: false,
  },
  {
    pattern: new RegExp(String.raw`${RUN_START}(?:Bearer|Basic)\s+(?<value>[^\s)"',;]+)`, "giu"),
    sentence: true,
    strict: false,
  },
  { pattern: /\b(?:pv|nd|cf)-[A-Za-z0-9_-]{8,}/gu, strict: false },
];

const STRICT_SHAPES = SHAPES.filter((shape) => shape.strict);

// Spoken secrets, after the memory policy as it stood before 22 November 2026.
const SPOKEN_LABEL = String.raw`(?:api[_ -]?key|access[_ -]?token|secret|password|парол[ья])`;
const SPOKEN_ASSIGNED = new RegExp(String.raw`${SPOKEN_LABEL}\s*[:=]\s*\S{8}`, "iu");
const SPOKEN_AFTER_SPACE = new RegExp(String.raw`${SPOKEN_LABEL}\s+(?=(?<value>\S{8,}))`, "giu");
const SPOKEN_SENTENCE_END = '.,;:!?…»")';
const CVV = /(?:cvv|cvc|код\s+с\s+оборот[а-я]*)(?:\s*[:=]\s*|\s*)\d{3,4}(?!\d)/iu;
const ONE_TIME_CODE = /(?:одноразов(?:ый|ого)\s+код|otp|2fa)(?:\s*[:=]\s*|\s*)\d{4,8}(?!\d)/iu;
// A run of digit groups split by single spaces or dashes. The one negative number Luhn could take for
// a card is a supergroup's chat id (`-100` and ten digits); any other run after a dash is read, as the
// memory policy did before 22 November 2026 (`Карта: -4111-…`, `(VISA)-4111-…`; repeat review,
// 23 November 2026).
const DIGIT_RUN = /(?<!\d)(?!(?<=-)100\d{10}(?!\d))\d+(?:[ -]\d+)*/gu;
const CARD_DIGITS_MIN = 13;
const CARD_DIGITS_MAX = 19;
const CARD_GROUP_MIN = 3;
const CARD_GROUP_MAX = 6;

function luhn(digits: string): boolean {
  if (/^(\d)\1+$/u.test(digits)) return false;
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

/**
 * A card is one group of 13 to 19 digits, or whole groups of three to six digits with 13 to 19 in
 * all (4-4-4-4, 4-6-5, 4-4-4-4-3), wherever in the run it starts and ends: «4242 4242 4242 4242
 * 12/27» carries its expiry in the same run, and a UUID of digits (8-4-4-4-12) is not one.
 */
function hasCardNumber(text: string): boolean {
  for (const [run] of text.matchAll(DIGIT_RUN)) {
    const groups = run.split(/[ -]/u);
    for (let first = 0; first < groups.length; first += 1) {
      const whole = groups[first]!;
      if (whole.length >= CARD_DIGITS_MIN) {
        if (whole.length <= CARD_DIGITS_MAX && luhn(whole)) return true;
        continue;
      }
      let digits = "";
      for (let last = first; last < groups.length; last += 1) {
        const group = groups[last]!;
        if (group.length < CARD_GROUP_MIN || group.length > CARD_GROUP_MAX) break;
        digits += group;
        if (digits.length > CARD_DIGITS_MAX) break;
        if (digits.length >= CARD_DIGITS_MIN && luhn(digits)) return true;
      }
    }
  }
  return false;
}

/**
 * Where `value` ends without its trailing run of `marks`. A loop, not `/[.,;]+$/`: that pattern
 * rescans a run of dots from each of its dots.
 */
function endWithoutTrailing(value: string, marks: string): number {
  let end = value.length;
  while (end > 0 && marks.includes(value[end - 1]!)) end -= 1;
  return end;
}

/** A word after a bare space is a secret with a digit or a sign the sentence did not add. */
function hasSpokenValueAfterSpace(text: string): boolean {
  for (const match of text.matchAll(SPOKEN_AFTER_SPACE)) {
    const value = match.groups!.value!;
    const word = value.slice(0, endWithoutTrailing(value, SPOKEN_SENTENCE_END));
    if (/[\d\p{P}\p{S}]/u.test(word)) return true;
  }
  return false;
}

function hasSpokenSecret(text: string): boolean {
  return (
    SPOKEN_ASSIGNED.test(text) ||
    hasSpokenValueAfterSpace(text) ||
    CVV.test(text) ||
    ONE_TIME_CODE.test(text) ||
    hasCardNumber(text)
  );
}

/**
 * A template's stand-in for a value, not a value: a variable (`$FAL_KEY`, `${FAL_KEY}`), a slot
 * (`{{TOKEN}}`, `<your api key>`), a mask (`********`), or words that ask for one (`your_fal_key`,
 * `YOUR_KEY_HERE`), a sentence's full stop or comma after it. Skills and messages quote such lines;
 * refusing them refused the advice to read a key from the environment (repeat review, 23 November
 * 2026). A variable is upper case: a real password may start with `$` (`$ecret12`). The words are
 * letters and separators only, starting with «your» or ending with «here»: «your» anywhere let
 * `Keep-your-7Cats!` through (narrow final review). Only a refusal lets a template through: logs and
 * the journal mask it as any value, since a real one may look like it (`DB_TOKEN=$K7QX9P2M4Z`,
 * `Bearer YourSessionToken…`; owner, «Шаблон только для отказов»).
 */
const PLACEHOLDER =
  /^["']?(?:\$\{?[A-Z_][A-Z0-9_]*\}?|\{\{[^}]*\}\}|<[^>]*>|[*xX.]+|[Yy][Oo][Uu][Rr][A-Za-z_-]*|[A-Za-z_-]*[_-](?:here|HERE))["']?[.,;]*$/u;

/** `refusal`: the caller refuses what it finds, and a template's stand-in is not a secret there. */
function* shapeSpans(text: string, shape: SecretShape, refusal = false): Generator<SecretSpan> {
  for (const match of text.matchAll(shape.pattern)) {
    const value = match.groups?.value ?? match[0];
    if (shape.accept && !shape.accept(value)) continue;
    const templated = match.groups?.value !== undefined && !shape.literal;
    if (refusal && templated && PLACEHOLDER.test(value)) continue;
    const start = match.index + match[0].length - value.length;
    const end = shape.sentence ? endWithoutTrailing(value, SENTENCE_PUNCTUATION) : value.length;
    // A value of nothing but punctuation is hidden whole.
    yield { end: start + (end === 0 ? value.length : end), start };
  }
}

function spansOf(text: string, shapes: readonly SecretShape[]): SecretSpan[] {
  return shapes.flatMap((shape) => [...shapeSpans(text, shape)]);
}

/** Replaces every merged run of spans with one mask. */
function hide(text: string, spans: readonly SecretSpan[]): string {
  if (spans.length === 0) return text;
  const ordered = [...spans].sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;
  let index = 0;
  while (index < ordered.length) {
    const start = ordered[index]!.start;
    let end = ordered[index]!.end;
    for (index += 1; index < ordered.length && ordered[index]!.start <= end; index += 1) {
      end = Math.max(end, ordered[index]!.end);
    }
    result += text.slice(cursor, start) + MASK;
    cursor = end;
  }
  return result + text.slice(cursor);
}

/**
 * Whether a field and its value read as a key in JSON (`{"api_key": "…"}`): neither half alone is
 * one. Only this form reads the pair; the others, over the made-up JSON, read an escaped line break
 * after `FAL_KEY=` in a plain field as a value (repeat review, 23 November 2026).
 */
const JSON_PAIR_AT_START: SecretShape = {
  pattern: new RegExp(String.raw`^\{${JSON_SECRET_PAIR.pattern.source}`, "giu"),
  strict: true,
};

export function isSecretJsonPair(key: string, value: string): boolean {
  // Only the pair itself: a quoted `'token': '…'` inside a plain field's text is not this pair.
  return !shapeSpans(JSON.stringify({ [key]: value }), JSON_PAIR_AT_START, true).next().done;
}

export function strictSecretSpans(text: string): SecretSpan[] {
  return spansOf(text, STRICT_SHAPES);
}

function maskSecrets(text: string, alsoHide: readonly SecretSpan[]): string {
  return hide(text, [...strictSecretSpans(text), ...alsoHide]);
}

export function journalText(
  text: string | null,
  alsoHide: readonly SecretSpan[] = [],
): string | null {
  if (text === null || hasSpokenSecret(text)) return null;
  return maskSecrets(text, alsoHide);
}

export function containsSecret(text: string): boolean {
  return (
    hasSpokenSecret(text) ||
    STRICT_SHAPES.some((shape) => !shapeSpans(text, shape, true).next().done)
  );
}

export function redactSecrets(value: string, exactSecrets: readonly string[] = []): string {
  let text = value;
  for (const secret of exactSecrets) {
    if (secret.length >= 8) text = text.split(secret).join(MASK);
  }
  return hide(text, spansOf(text, SHAPES));
}
