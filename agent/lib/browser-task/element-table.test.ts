/**
 * Element table tests.
 *
 * Constructs covered:
 * - The full accessibility snapshot becomes a numbered table: refs, roles, names from nested text.
 * - Operations follow the role: typing, selecting, clicking, entering a frame, clicking text.
 * - Text leaves without refs become choices, except field labels.
 * - Rendering, hashing, Jev criteria and parsing a choice back into an action.
 */
import { describe, expect, it } from "vitest";

import { actionCriteria, parseChoice, parseSnapshot, renderTable, tableHash } from "./element-table.js";

const SNAPSHOT = [
  `- generic`,
  `  - heading "Мы используем cookie" [level=2, ref=e5]`,
  `  - link "Закрыть" [ref=e4]`,
  `  - generic "Принять все" [ref=e1] clickable [cursor:pointer]`,
  `  - textbox "Телефон" [ref=e9] value="+7"`,
  `  - combobox "Мастер" [ref=e10]`,
  `    - option "Иван" [ref=e11]`,
  `  - button "Записаться" [ref=e12]`,
  `  - Iframe [ref=e22]`,
  `  - generic [ref=e2] clickable [cursor:pointer]`,
  `    - generic`,
  `      - image`,
  `      - StaticText "ФРАНТ Мещанка"`,
  `      - StaticText "ул. Мещанская, д. 12"`,
  `  - generic`,
  `    - StaticText "Телефон *"`,
  `    - StaticText "23"`,
  `    - StaticText "10:45"`,
  `    - StaticText "Мы придерживаемся индивидуального подхода к каждому клиенту и ценим ваше время"`,
].join("\n");

describe("parseSnapshot", () => {
  it("keeps ref elements with operations by role and names unnamed ones from nested text", () => {
    const table = parseSnapshot(SNAPSHOT);
    const rows = table.elements.map((e) => [e.index, e.ref, e.role, e.name, e.operations]);
    expect(rows).toEqual([
      [1, "e4", "link", "Закрыть", ["CLICK"]],
      [2, "e1", "generic", "Принять все", ["CLICK"]],
      [3, "e9", "textbox", "Телефон", ["TYPE_TEXT"]],
      // SELECT belongs to options only: on the list itself it selected in the previous list.
      [4, "e10", "combobox", "Мастер", ["TYPE_TEXT", "CLICK"]],
      [5, "e11", "option", "Иван", ["SELECT"]],
      [6, "e12", "button", "Записаться", ["CLICK"]],
      [7, "e22", "Iframe", "(фрейм)", ["ENTER"]],
      [8, "e2", "generic", "ФРАНТ Мещанка · ул. Мещанская, д. 12", ["CLICK"]],
      [9, null, "text", "23", ["TEXT"]],
      [10, null, "text", "10:45", ["TEXT"]],
    ]);
    expect(table.elements[2]!.value).toBe("+7");
  });

  it("caps the table at 120 elements", () => {
    const long = Array.from({ length: 150 }, (_, i) => `- button "Кнопка ${i}" [ref=e${i}]`).join("\n");
    expect(parseSnapshot(long).elements).toHaveLength(120);
  });
});

describe("renderTable, tableHash, actionCriteria, parseChoice", () => {
  it("renders values and typing hints, hashes content, and offers Jev only valid keys", () => {
    const table = parseSnapshot(SNAPSHOT);
    const rendered = renderTable(table);
    expect(rendered).toContain("[3] textbox Телефон · +7 (поле ввода)");
    expect(rendered).toContain("[9] вариант 23");
    expect(rendered).not.toContain("heading");

    const criteria = actionCriteria(table);
    expect(Object.keys(criteria)).toEqual(expect.arrayContaining([
      "CLICK [1]", "TYPE_TEXT [3]", "SELECT [5]", "CLICK [6]", "ENTER [7]", "TEXT [9]", "SCROLL_DOWN", "DONE", "BLOCKED",
    ]));
    expect(criteria).not.toHaveProperty("CLICK [5]");

    expect(tableHash(table)).toHaveLength(64);
    expect(tableHash(parseSnapshot(SNAPSHOT.replace('value="+7"', 'value="+79"')))).not.toBe(tableHash(table));
  });

  it("parses a choice back into an action and rejects impossible ones", () => {
    const table = parseSnapshot(SNAPSHOT);
    expect(parseChoice("CLICK [6]", table)).toEqual({ kind: "element", operation: "CLICK", index: 6 });
    expect(parseChoice("TEXT [10]", table)).toEqual({ kind: "element", operation: "TEXT", index: 10 });
    expect(parseChoice("SCROLL_DOWN", table)).toEqual({ kind: "SCROLL_DOWN" });
    expect(parseChoice("CLICK [5]", table)).toBeNull();
    expect(parseChoice("CLICK [99]", table)).toBeNull();
    expect(parseChoice("nonsense", table)).toBeNull();
  });
});
