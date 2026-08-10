/**
 * Telegram final-presentation selection tests.
 *
 * Constructs covered:
 * - Conversational text stays on the plain Telegram transport.
 * - Supported formatting selects Rich Message delivery.
 * - Long output is collapsed even when the model omits the mandatory details block.
 */
import { describe, expect, it } from "vitest";

import { formatTelegramFinalPresentation } from "./telegram-final-presentation.js";

describe("Telegram final presentation", () => {
  it.each([
    "да не, ерунда, я пробовала",
    "можно попробовать\nно я бы не стала усложнять",
    "цена 2 * 3 доллара",
    "цена $5, скидка $2",
    "цена $5 + $2",
    "было $100 - $80",
  ])("keeps conversational text plain: %s", (text) => {
    expect(formatTelegramFinalPresentation(text)).toEqual([{ format: "plain", text }]);
  });

  it.each([
    "**Да**, это важно",
    "## Итог\n\nГотово",
    "- первый вариант\n- второй вариант",
    "[Документация](https://example.com)",
    "«_важно_»",
    "<details><summary>Разбор</summary>\n\nТекст\n\n</details>",
  ])("selects Rich Message for supported formatting: %s", (markdown) => {
    expect(formatTelegramFinalPresentation(markdown)).toEqual([{
      format: "rich",
      text: markdown,
    }]);
  });

  it("recognizes a GFM table without outer pipes and collapses it", () => {
    const markdown = "Параметр | Значение\n--- | ---\nрежим | plain";
    const output = formatTelegramFinalPresentation(markdown)[0]!;

    expect(output.format).toBe("rich");
    expect(output.text).toContain("<details><summary>Полный ответ</summary>");
    expect(output.text).toContain(markdown);
  });

  it.each([
    "а".repeat(601),
    Array.from({ length: 8 }, (_, index) => `строка ${index + 1}`).join("\n"),
    "первый абзац\n\nвторой абзац\n\nтретий абзац",
    Array.from({ length: 6 }, (_, index) => `- пункт ${index + 1}`).join("\n"),
  ])("collapses output after any long-answer threshold", (text) => {
    const chunks = formatTelegramFinalPresentation(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ format: "rich" });
    expect(chunks[0]!.text).toContain("<details><summary>Полный ответ</summary>");
    expect(chunks[0]!.text).toContain("</details>");
  });

  it("keeps a short direct lead outside the generated accordion", () => {
    const body = "подробность ".repeat(70);

    expect(formatTelegramFinalPresentation(`короткий вывод\n\n${body}`)[0]!.text).toBe(
      `короткий вывод\n\n<details><summary>Полный ответ</summary>\n\n${body.trim()}\n\n</details>`,
    );
  });

  it("preserves an authored details block without wrapping it again", () => {
    const markdown = `<details><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n</details>`;

    expect(formatTelegramFinalPresentation(markdown)).toEqual([{ format: "rich", text: markdown }]);
  });

  it("recognizes an indented valid details block", () => {
    const markdown = `  <details open><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n  </details>`;

    const output = formatTelegramFinalPresentation(markdown)[0]!.text;
    expect(output.match(/<details/gu)).toHaveLength(1);
    expect(output).toContain("<details open><summary>Разбор</summary>");
  });

  it("wraps a long block whose details tag has forbidden attributes", () => {
    const markdown = `<details class="wide"><summary>Разбор</summary>\n\n${"текст ".repeat(150)}\n\n</details>`;

    const output = formatTelegramFinalPresentation(markdown)[0]!.text;
    expect(output).toContain("<details><summary>Полный ответ</summary>");
    expect(output).toContain("&lt;details class=\"wide\"&gt;");
  });

  it.each([
    `<details>\n\n${"текст ".repeat(150)}\n\n</details>`,
    `<details><summary>Разбор\n\n${"текст ".repeat(150)}`,
  ])("wraps malformed authored details instead of trusting it: %s", (markdown) => {
    const output = formatTelegramFinalPresentation(markdown)[0]!.text;

    expect(output).toContain("<details><summary>Полный ответ</summary>");
    expect(output).toContain("&lt;details&gt;");
  });

  it("keeps a short rich warning outside the generated accordion", () => {
    const body = "подробность ".repeat(70);

    expect(formatTelegramFinalPresentation(`**Риск высокий.**\n\n${body}`)[0]!.text).toBe(
      `**Риск высокий.**\n\n<details><summary>Полный ответ</summary>\n\n${body.trim()}\n\n</details>`,
    );
  });
});
