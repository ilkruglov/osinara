/**
 * Agent HITL-denial policy regression tests.
 *
 * Constructs covered:
 * - A user denial terminally cancels the current action and every model-invented alternative.
 * - The model asks once for the cancellation reason without treating the answer as authorization.
 * - A repeated approval is allowed only after an approved tool failed or returned no result.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const INSTRUCTIONS_PATH = new URL("../instructions.md", import.meta.url);

describe("agent HITL denial guidance", () => {
  it("treats denial as terminal instead of searching for another side effect", async () => {
    const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");

    expect(instructions).toContain("Отказ в HITL — терминальное решение");
    expect(instructions).toContain("не вызывай повторно тот же инструмент");
    expect(instructions).toContain("не предлагай и не запускай альтернативное действие");
    expect(instructions).toContain("задай один короткий вопрос о причине отмены и остановись");
    expect(instructions).toContain("Ответ с объяснением причины не является новым разрешением");
  });

  it("permits another approval only after an approved call has no usable result", async () => {
    const instructions = await readFile(INSTRUCTIONS_PATH, "utf8");

    expect(instructions).toContain("предыдущий запрос был подтверждён");
    expect(instructions).toContain("инструмент вернул явную ошибку");
    expect(instructions).toContain("не вернул проверяемого результата");
    expect(instructions).toContain("новой прямой команды пользователя");
    expect(instructions).toContain("не повторяй вызов автоматически");
  });
});
