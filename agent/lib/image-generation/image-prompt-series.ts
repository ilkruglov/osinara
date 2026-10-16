/**
 * Repeat check for a series of generated pictures.
 *
 * Exports:
 * - `promptElements`: the content phrases of an image prompt (pairs of stemmed words of its
 *   positive visual specification), without the quoted texts the user dictated, numbers,
 *   function and structural words and the constraints the prompt ends with.
 * - `repeatedPromptElements`: phrases the new prompt shares with earlier prompts of the series and
 *   that the model did not declare as kept on the user's request.
 * - `stemRussian`: the Snowball stemmer for Russian, so «кошка» and «кошки» are one word.
 * - `imagePromptSeries`: bounded per-session memory of the last prompts.
 * - `IMAGE_SERIES_REPEAT_LIMIT`: how many undeclared repeats make a prompt an echo of the previous
 *   one rather than a new variant.
 *
 * Key construct:
 * - A model writing the fifth variant copies its own fourth prompt: the hero, the prop in its
 *   hands, the palette (16 октября 2026: a tape reel in 14 of 16 prompts nobody asked for, the
 *   same robot under "five random styles"). Asking it not to changed little. The tool now refuses
 *   an echo before the billable call and names the repeats, so the model rewrites or declares
 *   what the user asked to keep; the declaration is a conscious claim, not inertia.
 */
export const IMAGE_SERIES_REPEAT_LIMIT = 4;
const SERIES_MAX_PROMPTS = 12;
const SERIES_MAX_SESSIONS = 300;
const MIN_WORD_LENGTH = 4;

/** Function words and the structural vocabulary every image prompt shares, as stems. */
const STOP_STEMS = new Set([
  "этот", "эт", "тог", "том", "такж", "либ", "есл", "чтоб", "когд", "очен", "почт", "кром", "тольк", "больш", "меньш", "всег", "вес", "сво", "сам", "будт", "вокруг", "рядом", "перед", "межд", "поверх", "внутр", "сверх", "сниз", "вверх", "вниз", "слев", "справ",
  "кадр", "сцен", "композиц", "вариант", "подач", "изображен", "картинк", "надпис", "текст", "строк", "крупн", "мелк", "центр", "центральн", "стил", "формат", "вертикальн", "горизонтальн", "обложк", "лист", "журнал", "плакат", "цел", "сюжет", "гер", "фон", "задник", "палитр", "цвет", "чист", "лин", "контур", "аккуратн", "нормальн", "человеческ", "кист", "палец", "пальц", "раздельн", "лиц", "люд", "реальн", "кажд", "один", "одн", "друг", "ровн", "строг", "больш",
]);
/** A segment that starts like this states what must not be in the picture, not what is. */
// `\b` knows no Cyrillic, so a word ends where no Cyrillic letter follows.
const NEGATIVE_SEGMENT = /^\s*(?:ограничени|запрет|нельзя|не(?![а-яё])|без(?![а-яё])|никак|нет(?![а-яё])|избега|исключ|кроме(?![а-яё]))/iu;
const NEGATIVE_TAIL = /[,;]\s*(?:без|никак[а-яё]*|нет|не|нельзя|избега[а-яё]*|исключ[а-яё]*|кроме)(?![а-яё]).*$/iu;
const QUOTED = /«[^»]*»|"[^"]*"|“[^”]*”/gu;
const SIZE_OR_NUMBER = /\d+(?:[.,:x×/-]\d+)*/gu;

const VOWELS = "аеиоуыэюя";
const PERFECTIVE_GERUND_1 = ["вшись", "вши", "в"];
const PERFECTIVE_GERUND_2 = ["ившись", "ывшись", "ивши", "ывши", "ив", "ыв"];
const ADJECTIVE = ["ими", "ыми", "его", "ого", "ему", "ому", "ее", "ие", "ые", "ое", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею"];
const PARTICIPLE_1 = ["ем", "нн", "вш", "ющ", "щ"];
const PARTICIPLE_2 = ["ивш", "ывш", "ующ"];
const REFLEXIVE = ["ся", "сь"];
const VERB_1 = ["ете", "йте", "ешь", "нно", "ла", "на", "ли", "ем", "ло", "но", "ет", "ют", "ны", "ть", "й", "л", "н"];
const VERB_2 = ["ейте", "уйте", "ила", "ыла", "ена", "ите", "или", "ыли", "ило", "ыло", "ено", "ует", "уют", "ены", "ить", "ыть", "ишь", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ят", "ит", "ыт", "ую", "ю"];
const NOUN = ["иями", "ями", "ами", "ией", "иям", "ием", "иях", "ев", "ов", "ие", "ье", "еи", "ии", "ей", "ой", "ий", "ям", "ем", "ам", "ом", "ах", "ях", "ию", "ью", "ия", "ья", "а", "е", "и", "й", "о", "у", "ы", "ь", "ю", "я"];
const DERIVATIONAL = ["ость", "ост"];

function regions(word: string): { rv: number; r2: number } {
  let rv = word.length;
  for (let index = 0; index < word.length; index += 1) {
    if (VOWELS.includes(word[index]!)) { rv = index + 1; break; }
  }
  let r1 = word.length;
  for (let index = 1; index < word.length; index += 1) {
    if (VOWELS.includes(word[index - 1]!) && !VOWELS.includes(word[index]!)) { r1 = index + 1; break; }
  }
  let r2 = word.length;
  for (let index = r1 + 1; index < word.length; index += 1) {
    if (VOWELS.includes(word[index - 1]!) && !VOWELS.includes(word[index]!)) { r2 = index + 1; break; }
  }
  return { r2, rv };
}

function stripEnding(word: string, rv: number, endings: readonly string[], precededByAorYa = false): string | null {
  for (const ending of endings) {
    if (!word.endsWith(ending) || word.length - ending.length < rv) continue;
    if (precededByAorYa) {
      // The а/я belongs to the match, so it has to lie inside RV as well («кран» keeps its н).
      const at = word.length - ending.length - 1;
      if (at < rv || (word[at] !== "а" && word[at] !== "я")) continue;
    }
    return word.slice(0, -ending.length);
  }
  return null;
}

/** Snowball's Russian stemmer: inflected forms of one word share one stem. */
export function stemRussian(input: string): string {
  let word = input.toLowerCase().replace(/ё/gu, "е");
  if (word.length < 3 || !/^[а-я]+$/u.test(word)) return word;
  const { r2, rv } = regions(word);
  // Step 1.
  const gerund = stripEnding(word, rv, PERFECTIVE_GERUND_1, true) ?? stripEnding(word, rv, PERFECTIVE_GERUND_2);
  if (gerund !== null) {
    word = gerund;
  } else {
    word = stripEnding(word, rv, REFLEXIVE) ?? word;
    const adjective = stripEnding(word, rv, ADJECTIVE);
    if (adjective !== null) {
      word = adjective;
      word = stripEnding(word, rv, PARTICIPLE_1, true) ?? stripEnding(word, rv, PARTICIPLE_2) ?? word;
    } else {
      const verb = stripEnding(word, rv, VERB_1, true) ?? stripEnding(word, rv, VERB_2);
      word = verb ?? stripEnding(word, rv, NOUN) ?? word;
    }
  }
  // Step 2.
  if (word.endsWith("и") && word.length - 1 >= rv) word = word.slice(0, -1);
  // Step 3.
  for (const ending of DERIVATIONAL) {
    if (word.endsWith(ending) && word.length - ending.length >= r2) { word = word.slice(0, -ending.length); break; }
  }
  // Step 4.
  if (word.endsWith("ь") && word.length - 1 >= rv) word = word.slice(0, -1);
  else if (word.endsWith("ейше") && word.length - 4 >= rv) word = word.slice(0, -4);
  else if (word.endsWith("ейш") && word.length - 3 >= rv) word = word.slice(0, -3);
  if (word.endsWith("нн") && word.length - 1 >= rv) word = word.slice(0, -1);
  return word;
}

/** The sentences and lines that say what is in the picture, without the ones that say what is not. */
function positiveSpecification(prompt: string): string {
  return prompt
    .replace(QUOTED, " ")
    .split(/\n+|(?<=[.!?;])\s+/u)
    .filter((segment) => !NEGATIVE_SEGMENT.test(segment))
    .map((segment) => segment.replace(NEGATIVE_TAIL, ""))
    .join(" ");
}

/** Content words of a text: hyphen components apart, ё as е, no numbers, no function or structural words. */
function contentWords(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().replace(/ё/gu, "е").replace(SIZE_OR_NUMBER, " ").match(/[а-яa-z-]+/gu) ?? [])
    .flatMap((word) => word.split("-"))
    .filter((word) => word.length >= MIN_WORD_LENGTH && !STOP_STEMS.has(stemRussian(word)));
}

/** Stemmed word pairs of the prompt's positive content, each paired with the words it came from. */
export function promptElements(prompt: string): Map<string, string> {
  const words = contentWords(positiveSpecification(prompt));
  const elements = new Map<string, string>();
  for (let index = 0; index + 1 < words.length; index += 1) {
    const key = `${stemRussian(words[index]!)} ${stemRussian(words[index + 1]!)}`;
    if (!elements.has(key)) elements.set(key, `${words[index]} ${words[index + 1]}`);
  }
  return elements;
}

/**
 * Phrases of `prompt` that also occur in any of `previous` and are not covered by `keep`: a pair is
 * kept only when both of its stems appear in the declared keep list. Replay of the Дизраптим
 * series (16 октября 2026): tolerating one declared stem per pair let more of the old picture
 * through (tape reel 27 % of prompts against 20 %, paper 16 % against 4 %) and saved almost no
 * refusals (35 against 40 for about the same number of pictures), so the strict rule stays.
 */
export function repeatedPromptElements(
  prompt: string,
  previous: readonly string[],
  keep: readonly string[] = [],
): string[] {
  const current = promptElements(prompt);
  const earlier = new Set(previous.flatMap((text) => [...promptElements(text).keys()]));
  const kept = new Set(keep.flatMap((text) => contentWords(text.replace(QUOTED, " ")).map(stemRussian)));
  const repeated: string[] = [];
  for (const [key, phrase] of current) {
    if (!earlier.has(key)) continue;
    const [first, second] = key.split(" ") as [string, string];
    if (kept.has(first) && kept.has(second)) continue;
    repeated.push(phrase);
  }
  return repeated;
}

export interface ImagePromptSeries {
  previous(sessionKey: string): readonly string[];
  remember(sessionKey: string, prompt: string): void;
}

/** Last prompts per application session; a lost process means a fresh series, nothing worse. */
export function createImagePromptSeries(maxSessions: number = SERIES_MAX_SESSIONS, maxPrompts: number = SERIES_MAX_PROMPTS): ImagePromptSeries {
  const sessions = new Map<string, string[]>();
  return {
    previous(sessionKey) {
      return sessions.get(sessionKey) ?? [];
    },
    remember(sessionKey, prompt) {
      const prompts = sessions.get(sessionKey) ?? [];
      sessions.delete(sessionKey);
      // A replayed call brings the same prompt again; it is one picture, not two.
      if (!prompts.includes(prompt)) prompts.push(prompt);
      while (prompts.length > maxPrompts) prompts.shift();
      sessions.set(sessionKey, prompts);
      while (sessions.size > maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    },
  };
}

export const imagePromptSeries = createImagePromptSeries();
