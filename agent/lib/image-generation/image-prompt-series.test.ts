/**
 * Image prompt series tests.
 *
 * Constructs covered:
 * - The stemmer joins the inflected forms of one word, including ё/е and hyphen components.
 * - Elements are stemmed word pairs of the positive content: quoted texts, numbers, function and
 *   structural words and the constraints sentences do not count.
 * - A repeat is a pair shared with any earlier prompt of the series; a pair whose both words the
 *   model declared in `keep` is the user's wish, not inertia, in whatever case form.
 * - The series memory keeps the last prompts per session, once each, and stays bounded.
 */
import { describe, expect, it } from "vitest";

import {
  createImagePromptSeries,
  IMAGE_SERIES_REPEAT_LIMIT,
  promptElements,
  repeatedPromptElements,
  stemRussian,
} from "./image-prompt-series.js";

const FIRST = "Вертикальный кадр 2:3, стиль ретро-плаката 1950-х, пожелтевшая бумага и полутоновая печать. Сцена: ретро-робот с ламповыми глазами держит катушку магнитной ленты, за спиной три серверные стойки. Надпись крупно: «ТРИ ДЦ ЛЕГЛИ». Ограничения: только русские буквы, ни разу опечаток, мелкого псевдотекста, водяных знаков и логотипов.";
const ECHO = "Обложка журнала, синкретический стиль: барокко и укиё-э. Центр: ретро-робот с ламповыми глазами на шестерне, в руке катушка магнитной ленты, за спиной три серверные стойки. Надпись крупно: «ТРИ ДЦ ЛЕГЛИ». Ограничения: ни разу опечаток, водяных знаков и логотипов.";
const FRESH = "Обложка журнала, барокко и укиё-э: сова-курьер в клюве несёт конверт, вокруг летят свитки, на груди почтовая сумка. Надпись крупно: «ТРИ ДЦ ЛЕГЛИ». Ограничения: ни разу опечаток, водяных знаков и логотипов.";

describe("stemRussian", () => {
  it("joins the inflected forms of a word", () => {
    expect(stemRussian("кошка")).toBe(stemRussian("кошки"));
    expect(stemRussian("катушку")).toBe(stemRussian("катушка"));
    expect(stemRussian("ламповыми")).toBe(stemRussian("ламповые"));
    expect(stemRussian("серверные")).toBe(stemRussian("серверных"));
    expect(stemRussian("робота")).toBe(stemRussian("робот"));
    expect(stemRussian("жёлтая")).toBe(stemRussian("желтой"));
    expect(stemRussian("робот")).not.toBe(stemRussian("девушка"));
  });

  it("keeps the а/я of a verb ending inside RV, so short nouns are not cut", () => {
    expect(stemRussian("кран")).toBe("кран");
    expect(stemRussian("краном")).toBe("кран");
    expect(stemRussian("план")).toBe("план");
    expect(stemRussian("клан")).toBe("клан");
    expect(stemRussian("кран")).not.toBe(stemRussian("край"));
    expect(stemRussian("читала")).toBe("чита");
  });
});

describe("promptElements", () => {
  it("keeps content pairs and drops quotes, numbers, structural words and the constraints line", () => {
    const elements = [...promptElements(FIRST).values()];
    expect(elements).toContain("ретро робот");
    expect(elements).toContain("катушку магнитной");
    expect(elements.some((phrase) => phrase.includes("легли") || phrase.includes("дц"))).toBe(false);
    expect(elements.some((phrase) => /опечаток|водяных|логотипов|русские|буквы/u.test(phrase))).toBe(false);
    expect(elements.some((phrase) => /\d/u.test(phrase))).toBe(false);
  });

  it("ignores what a prompt says must not be there, as a sentence or as a tail", () => {
    const negatives = "Кошка на окне. Не рисуй ретро-робота с ламповыми глазами и катушку магнитной ленты. Фон тёплый, без серверных стоек и магнитной ленты.";
    const elements = [...promptElements(negatives).values()].join(" | ");
    expect(elements).not.toContain("ламповыми");
    expect(elements).not.toContain("магнитной");
    expect(elements).not.toContain("стоек");
    expect(elements).toContain("кошка окне");
  });

  it("ignores a negation that follows a comma inside a sentence", () => {
    const previous = "Сцена: ретро-робот с ламповыми глазами держит катушку магнитной ленты, за спиной серверные стойки.";
    const current = "Сова на ветке, не рисуй ретро-робота с ламповыми глазами, катушку магнитной ленты и серверные стойки.";
    expect(repeatedPromptElements(current, [previous])).toEqual([]);
    const excluded = "Сова на ветке; исключить ретро-робота с ламповыми глазами. Фон: лес, кроме серверных стоек и катушек магнитной ленты.";
    expect(repeatedPromptElements(excluded, [previous])).toEqual([]);
  });

  it("treats ё and е, and the parts of a hyphenated word, as the same words", () => {
    const a = [...promptElements("Жёлтая ретро-девушка с зелёным зонтом").keys()];
    const b = [...promptElements("желтая ретро девушка с зеленым зонтом").keys()];
    expect(a).toEqual(b);
  });
});

describe("repeatedPromptElements", () => {
  it("names the pairs an echo shares with the series and ignores what the user asked to keep", () => {
    const repeated = repeatedPromptElements(ECHO, [FIRST]);
    expect(repeated).toEqual(expect.arrayContaining(["ретро робот", "ламповыми глазами", "магнитной ленты", "серверные стойки"]));
    expect(repeated.length).toBeGreaterThanOrEqual(IMAGE_SERIES_REPEAT_LIMIT);
    const kept = repeatedPromptElements(ECHO, [FIRST], ["сюжет: ретро-робот с ламповыми глазами и катушкой магнитной ленты, три серверные стойки"]);
    expect(kept.length).toBeLessThan(IMAGE_SERIES_REPEAT_LIMIT);
    expect(kept).not.toContain("ламповыми глазами");
    // Half a declaration is no declaration: both words of a pair must be kept.
    const partial = repeatedPromptElements(ECHO, [FIRST], ["робот", "стойки"]);
    expect(partial).toContain("ретро робот");
    expect(partial).toContain("магнитной ленты");
  });

  it("matches a keep written in another case form", () => {
    const previous = "Белая кошка в рыжей шубе с синей лентой и яркой рамкой на окне.";
    const current = "Та же белая кошка, рыжая шуба, синяя лента, яркая рамка, теперь на крыше дома.";
    expect(repeatedPromptElements(current, [previous]).length).toBeGreaterThanOrEqual(IMAGE_SERIES_REPEAT_LIMIT);
    expect(repeatedPromptElements(current, [previous], ["кошка, белая шуба, рыжая морда, синяя лента, яркая рамка"])).toEqual([]);
  });

  it("passes a genuinely new picture and the first picture of a series", () => {
    expect(repeatedPromptElements(FRESH, [FIRST]).length).toBeLessThan(IMAGE_SERIES_REPEAT_LIMIT);
    expect(repeatedPromptElements(FIRST, [])).toEqual([]);
  });
});

describe("createImagePromptSeries", () => {
  it("remembers the last prompts per session once each and forgets the oldest session beyond the bound", () => {
    const series = createImagePromptSeries(2, 2);
    series.remember("a", "один");
    series.remember("a", "один");
    series.remember("a", "два");
    series.remember("a", "три");
    expect(series.previous("a")).toEqual(["два", "три"]);
    series.remember("b", "б");
    series.remember("c", "в");
    expect(series.previous("a")).toEqual([]);
    expect(series.previous("c")).toEqual(["в"]);
  });
});
