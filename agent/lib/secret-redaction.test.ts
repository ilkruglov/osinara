/**
 * Secrets in text: machine forms masked in place, a secret told in words hides the whole text.
 *
 * Constructs covered:
 * - Machine forms (provider keys, a Telegram bot token, Bearer, PEM, a password in a URL,
 *   `NAME_KEY=` assignments, JSON `"api_key": "…"`): `journalText` hides the value and keeps the
 *   label, idempotently; `containsSecret` and `redactSecrets` see them; a fal key behind `sk-` or
 *   between Markdown underscores is hidden whole; an empty `FAL_KEY=` takes nothing from the next
 *   line; a quoted value runs to its own quote.
 * - Spoken secrets (a password in words, a card by Luhn, CVV, a one-time code): `journalText` keeps
 *   no text, `containsSecret` sees them. After a bare space a value is a secret only with a digit or
 *   a sign once the sentence's own punctuation is cut (owner, 22 November 2026).
 * - Ordinary speech and code that only names a key are neither.
 * - Lenient shapes (`Basic …`, any-case assignments, `pv-` keys) reach only `redactSecrets`.
 * - Every reader runs in linear time on long runs of labels and key characters.
 */
import { describe, expect, it } from "vitest";

import { containsSecret, journalText, redactSecrets } from "./secret-redaction.js";

const FAL_SHAPED_KEY = `abcdefghij0123456789KLMNOPQRSTuvwxyz012:${"0123456789abcdef".repeat(2)}`;
const BOT_SHAPED_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

// Each machine form with the text the journal keeps of it.
const MACHINE: readonly (readonly [string, string])[] = [
  [`sk-${FAL_SHAPED_KEY}`, "[СКРЫТО]"],
  [`ключ sk-${FAL_SHAPED_KEY} отозван`, "ключ [СКРЫТО] отозван"],
  [`FAL_KEY=${FAL_SHAPED_KEY}`, "FAL_KEY=[СКРЫТО]"],
  [`key ${FAL_SHAPED_KEY} rejected`, "key [СКРЫТО] rejected"],
  // The id run takes the glued word with it.
  [`x-${FAL_SHAPED_KEY} end`, "[СКРЫТО] end"],
  // Markdown italics: the closing underscore is not part of the key.
  [`ключ _${FAL_SHAPED_KEY}_`, "ключ [СКРЫТО]_"],
  ["ключ _sk-proj-abcdefgh12_", "ключ _[СКРЫТО]"],
  ["sk-proj-abcdefgh12", "[СКРЫТО]"],
  ["токен cfat_abcdefgh12", "токен [СКРЫТО]"],
  ["Authorization: Bearer abcdefghijklmnop1234", "Authorization: Bearer [СКРЫТО]"],
  [
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----\nпосле",
    "-----BEGIN RSA PRIVATE KEY-----[СКРЫТО]\nпосле",
  ],
  ["ключ FAL_KEY=abcdefghij0123456789, не теряй", "ключ FAL_KEY=[СКРЫТО], не теряй"],
  ["GITHUB_TOKEN: ghp_abcdefghij", "GITHUB_TOKEN: [СКРЫТО]"],
  ["fal_key=secretvalue123", "fal_key=[СКРЫТО]"],
  ["(fal_key=secretvalue123)", "(fal_key=[СКРЫТО])"],
  ["postgres://app:hunter22@db:5432/osinara", "postgres://app:[СКРЫТО]@db:5432/osinara"],
  ["redis://:hunter22@cache:6379", "redis://:[СКРЫТО]@cache:6379"],
  ["postgres://app:hunter22.@db/osinara", "postgres://app:[СКРЫТО]@db/osinara"],
  ['{"api_key": "abcdefghijklmnop"}', '{"api_key": "[СКРЫТО]"}'],
  ['{"refresh_token":"abcdefghijklmnop"}', '{"refresh_token":"[СКРЫТО]"}'],
  // Repeat review, 23 November 2026: the mask left the secret's tail visible.
  [`TELEGRAM_BOT_TOKEN=${BOT_SHAPED_TOKEN}`, "TELEGRAM_BOT_TOKEN=[СКРЫТО]"],
  [`BOT_TOKEN: ${BOT_SHAPED_TOKEN} готов`, "BOT_TOKEN: [СКРЫТО] готов"],
  [`токен ${BOT_SHAPED_TOKEN} от бота`, "токен [СКРЫТО] от бота"],
  // Bot API addresses put the token right after `bot` (repeat review, 23 November 2026).
  [
    `https://api.telegram.org/bot${BOT_SHAPED_TOKEN}/getMe`,
    "https://api.telegram.org/bot[СКРЫТО]/getMe",
  ],
  [`TELEGRAM_BOT_TOKEN=bot${BOT_SHAPED_TOKEN}`, "TELEGRAM_BOT_TOKEN=[СКРЫТО]"],
  [`BOT_TOKEN:${BOT_SHAPED_TOKEN}`, "BOT_TOKEN:[СКРЫТО]"],
  // Markdown italics around the token, as for a fal key above (repeat review, 23 November 2026).
  // The secret may hold `_`, so the closing underscore goes with it.
  [`токен _${BOT_SHAPED_TOKEN}_`, "токен _[СКРЫТО]"],
  [`токен-${BOT_SHAPED_TOKEN}`, "токен-[СКРЫТО]"],
  // Labels in Markdown italics (repeat review, 23 November 2026).
  ["_FAL_KEY=abcdefghij0123456789_", "_FAL_KEY=[СКРЫТО]"],
  ["__GITHUB_TOKEN=ghp_abcdefghij1234567890__", "__GITHUB_TOKEN=[СКРЫТО]"],
  ["_Bearer abcdefghijklmnop1234_", "_Bearer [СКРЫТО]"],
  [`_bot${BOT_SHAPED_TOKEN}_`, "_bot[СКРЫТО]"],
  // A password that starts with `$` is not a variable.
  ["DB_TOKEN=$ecret1234xyz", "DB_TOKEN=[СКРЫТО]"],
  ["mysql://root:P@ssw0rd@localhost:3306/app", "mysql://root:[СКРЫТО]@localhost:3306/app"],
  ["postgres://app:sample@tail@db/app и всё", "postgres://app:[СКРЫТО]@db/app и всё"],
  [`{"api_key":"O'Brien12345"}`, '{"api_key":"[СКРЫТО]"}'],
  ['{"password": "my long pass phrase"}', '{"password": "[СКРЫТО]"}'],
  [String.raw`{"api_key": "abc\"defghijkl"}`, '{"api_key": "[СКРЫТО]"}'],
  [`FAL_KEY="O'Brien12345" готов`, "FAL_KEY=[СКРЫТО] готов"],
  // «your» inside a real password is no template (narrow final review, 23 November 2026).
  ["postgres://app:Keep-your-7Cats!@db/app", "postgres://app:[СКРЫТО]@db/app"],
  ["FAL_KEY=Hide_your_key_2026", "FAL_KEY=[СКРЫТО]"],
];

// Secrets told in words: the journal keeps no text of them.
const SPOKEN: readonly string[] = [
  "Пароль: correct-horse-battery-staple",
  "пароль: abcdefgh",
  "пароль: administrator",
  "Пароль: «Qwerty123»",
  "пароль `abc12345`",
  "пароль <Qwerty123>",
  "пароль Qwerty-12345",
  "пароль Qwerty123",
  "Пароль: abc123def. Не забудь",
  "Вайфай: пароль: abcdefgh12, гостевой пароль: Zxcvbnm98",
  "API key sk_test_1234567890abcdef",
  "DB_PASSWORD=letmeinplease",
  "Карта 4242 4242 4242 4242, срок 12/27",
  "Карта 4242 4242 4242 4242 12/27",
  "карта 4242-4242-4242-4242",
  "карта 4111111111111111",
  // The base caught a card after a dash (repeat review, 23 November 2026).
  "Карта VISA-4111-1111-1111-1111",
  "Карта: -4111-1111-1111-1111",
  "(VISA)-4111-1111-1111-1111",
  "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----4111111111111111",
  "Amex 3782 822463 10005",
  "CVV: 123",
  "cvc 123",
  "код с оборота 4567",
  "Одноразовый код: 123456",
  "OTP 9876",
  // The memory policy's rule reads code as well; hidden whole as before the seventh round.
  'api_key = os.environ["FAL_KEY"]',
  "password = settings.password_for(user)",
  // A rich table's row as the journal shows it, its cells split by a tab (owner, «Ячейки через
  // табуляцию», 23 November 2026).
  "Пароль:\tQwerty12345",
  "Пароль\tQwerty12345",
];

const NOT_SECRET: readonly string[] = [
  // A number and a UUID is an id, not a bot token, in italics too.
  "заказ 123456:550e8400-e29b-41d4-a716-446655440000",
  "_заказ 123456:550e8400-e29b-41d4-a716-446655440000_",
  "заказ 123456:550e8400-e29b-41d4-a716-446655440000->готов",
  // A Markdown table naming a password column tells none (narrow final review, 23 November 2026).
  "| password | varchar(255) |",
  "| Поле | Тип |\n| password | bcrypt-хэш |",
  "| secret | HMAC-SHA256 |",
  // A supergroup's id after its dash is not a card.
  "чат -1001234567896",
  "sort_key: created_at",
  "cache_key = make_key(chat, day)",
  "fal_key=secretvalue",
  "Basic usage of the tool",
  "время 12:30, порт 8080",
  "Обновил Node до 24.8.0, Python 3.12.4",
  "пароль от вайфая на кухне",
  // Owner, 22 November 2026: after a bare space a word is a secret only with a digit or a sign.
  "Сбросила пароль администратора.",
  "Сбросила пароль администратора",
  "Какой пароль поставить?",
  "введи пароль пользователя",
  "без пароля невозможно",
  "Пароль должен быть длиннее восьми символов",
  "secret ingredient",
  "Карта 4242 4242 4242 4241",
  "чат -1001234567896",
  // A UUID of digits is no card, though a window of it passes Luhn (8000-000000000003).
  "пример 00000000-0000-4000-8000-000000000003",
  "Телефоны 8 800 555 35 35 и 8 800 555 35 36",
  "https://example.com:8080/path",
  "Bearer of bad news",
  "FAL_KEY=\nпродолжение строки",
  "FAL_KEY=[СКРЫТО]",
  '{"api_key": "[СКРЫТО]"}',
  "postgres://app:[СКРЫТО]@db/osinara",
];

// A template names a value and holds none: a refusal lets it through, as a skill quoting a `.env`
// line needs; logs and the journal mask it like any value, since a real value may look like one
// (owner, «Шаблон только для отказов», 23 November 2026).
const TEMPLATES: readonly (readonly [string, string])[] = [
  ["FAL_KEY=your_fal_key", "FAL_KEY=[СКРЫТО]"],
  ["FAL_KEY=YOUR_KEY_HERE", "FAL_KEY=[СКРЫТО]"],
  ["export FAL_KEY=$FAL_KEY", "export FAL_KEY=[СКРЫТО]"],
  ['export FAL_KEY="$RUNTIME_KEY"', "export FAL_KEY=[СКРЫТО]"],
  // A sentence may end right after the template.
  ["Пример: FAL_KEY=$FAL_KEY.", "Пример: FAL_KEY=[СКРЫТО]."],
  ["Возьми FAL_KEY=your_fal_key, потом запусти", "Возьми FAL_KEY=[СКРЫТО], потом запусти"],
  ["Authorization: Bearer YOUR_ACCESS_TOKEN", "Authorization: Bearer [СКРЫТО]"],
  ['{"token": "{{TOKEN}}"}', '{"token": "[СКРЫТО]"}'],
  ['{"api_key": "<your api key>"}', '{"api_key": "[СКРЫТО]"}'],
  // Real values that look like templates: masked where nothing is refused.
  ["DB_TOKEN=$K7QX9P2M4Z", "DB_TOKEN=[СКРЫТО]"],
  ["Authorization: Bearer YourSessionTokenAbcdef", "Authorization: Bearer [СКРЫТО]"],
];

describe("templates", () => {
  it.each(TEMPLATES)("refuses no %j and masks it everywhere else", (text, masked) => {
    expect(containsSecret(text)).toBe(false);
    expect(journalText(text)).toBe(masked);
    expect(redactSecrets(text)).not.toBe(text);
  });

  it("never reads a private key's body as a template", () => {
    expect(containsSecret("-----BEGIN PRIVATE KEY-----<MIIEvQIBADANBg>")).toBe(true);
  });
});

describe("machine forms", () => {
  it.each(MACHINE)("masks %j in place with its label kept", (text, masked) => {
    expect(journalText(text)).toBe(masked);
    expect(containsSecret(text)).toBe(true);
    expect(redactSecrets(text)).not.toBe(text);
  });

  it.each(MACHINE)("masks %j idempotently and leaves no secret behind", (_text, masked) => {
    expect(journalText(masked)).toBe(masked);
    expect(containsSecret(masked)).toBe(false);
  });

  it("hides the whole fal key behind sk- in logs as well", () => {
    expect(redactSecrets(`key sk-${FAL_SHAPED_KEY}`)).toBe("key [СКРЫТО]");
  });
});

describe("spoken secrets", () => {
  it.each(SPOKEN)("keeps no text of %j", (text) => {
    expect(journalText(text)).toBeNull();
    expect(containsSecret(text)).toBe(true);
  });
});

describe("ordinary text", () => {
  it.each(NOT_SECRET)("leaves %j alone", (text) => {
    expect(journalText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it("keeps a missing text missing", () => {
    expect(journalText(null)).toBeNull();
  });
});

describe("lenient shapes", () => {
  it.each([
    ["Basic dXNlcjpwYXNzd29yZA==", "Basic [СКРЫТО]"],
    ["sort_key: created_at", "sort_key: [СКРЫТО]"],
    ["client_credentials=abc", "client_credentials=[СКРЫТО]"],
    ["pv-abcdefgh123", "[СКРЫТО]"],
    ["Authorization: Bearer short", "Authorization: Bearer [СКРЫТО]"],
  ])("redacts %j only in logs", (text, redacted) => {
    expect(redactSecrets(text)).toBe(redacted);
    expect(journalText(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it("hides the given exact secrets", () => {
    expect(redactSecrets("token ya29.long-access-token ok", ["ya29.long-access-token"])).toBe(
      "token [СКРЫТО] ok",
    );
  });
});

// A shape anchored on `\b` restarted at every dash of a run and rescanned its tail (9 s); a nested
// `\s*[:=]?\s*` split one whitespace run two ways (quadratic); a labelled word value failing on a
// bracket at the end was read again from every later label (5.5 s). Each input is ~100 000 characters.
describe("linear time", () => {
  const inputs: readonly (readonly [string, string])[] = [
    ["a-a-…", "a-".repeat(50_000)],
    ["a_a_…", "a_".repeat(50_000)],
    ["A_KEY …", "A_KEY ".repeat(16_667)],
    ["a_key=a1a1…(", `a_key=${"a1".repeat(49_996)}(`],
    ["A_KEY=A_KEY=…(", `${"A_KEY=".repeat(16_666)}(`],
    ["a_key=a_key=…(", `${"a_key=".repeat(16_666)}(`],
    ["A_TOKEN:A_TOKEN:…(", `${"A_TOKEN:".repeat(12_500)}(`],
    ["пароль:пароль:…(", `${"пароль:".repeat(14_285)}(`],
    ["пароль word …", "пароль abcdefgh ".repeat(6_250)],
    ["password then spaces", `password${" ".repeat(99_992)}`],
    ["cvv then spaces", `cvv${" ".repeat(99_997)}x`],
    ["otp then spaces", `otp${" ".repeat(99_997)}x`],
    ["sk-sk-…", "sk-".repeat(33_333)],
    ["digits and spaces", "1 2 3 4 5 6 7 8 9 0 ".repeat(5_000)],
    ["digit groups", "1234-".repeat(20_000)],
    ["url colons", `://${"a:".repeat(49_998)}`],
    ["urls without @", "://a:b/".repeat(14_285)],
    ["url @ runs", `://a:${"b@".repeat(49_997)}`],
    ["urls with @ and no host end", "://a:b@c@".repeat(11_111)],
    ["json values without a closing quote", '"api_key":"abcdefgh '.repeat(5_000)],
    ["bot ids and colons", "1234567:".repeat(12_500)],
    ["labels quoted both ways", `${"A_KEY='A_KEY=\"".repeat(7_000)}`],
    ["escapes in a JSON value", `"api_key":"${"\\a".repeat(49_990)}`],
    ["quotes", '"a'.repeat(50_000)],
    ["pem without end", `-----BEGIN PRIVATE KEY-----${"A ".repeat(49_986)}`],
    ["bare value then dots", `FAL_KEY=${"a".repeat(8)}${".".repeat(99_984)}(`],
    // A label may start after the underscores of italics; each was searched back to the run's
    // start, 1.4 s for 64 000 (narrow final review, 23 November 2026).
    ["underscores", "_".repeat(100_000)],
    ["underscores then a label", `${"_".repeat(99_990)}FAL_KEY=`],
  ];

  it.each(inputs)("reads %s within 500 ms", (_name, text) => {
    for (const read of [journalText, redactSecrets, containsSecret]) {
      const started = performance.now();
      read(text);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
