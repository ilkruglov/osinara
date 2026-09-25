/**
 * Page view tests: the marked-page result the model reads and the scripts that produce it.
 *
 * Constructs covered:
 * - The mark script and the act script are valid JavaScript expressions that share one registry.
 * - A raw mark result is validated into a `PageView`; malformed rows are dropped, not thrown.
 * - Rendering keeps numbers, roles, text, values and state on one line each.
 * - The content hash ignores numbering and follows text, values and state.
 */
import { describe, expect, it } from "vitest";

import { actScript, clearScript, markScript, SOM_REGISTRY } from "./som-script.js";
import { parsePageView, renderElements, viewHash } from "./page-view.js";

describe("som scripts", () => {
  it.each([
    ["mark", markScript("ep-1")],
    ["clear", clearScript()],
    ["act", actScript("ep-1", 3, { kind: "click" })],
    ["fill", actScript("ep-1", 3, { kind: "fill", text: "Илья \"Q\" 'z'" })],
    ["select", actScript("ep-1", 3, { kind: "select", option: "Утро" })],
  ])("%s script is one JavaScript expression", (_name, script) => {
    // oxlint-disable-next-line typescript/no-implied-eval -- parsing the fixed page script proves it is valid JavaScript
    expect(() => new Function(`return (${script});`)).not.toThrow();
  });

  it("binds marking and acting to the same registry, with the action's own epoch and number", () => {
    expect(markScript("ep-1")).toContain(SOM_REGISTRY);
    const act = actScript("ep-1", 3, { kind: "click" });
    expect(act).toContain(SOM_REGISTRY);
    expect(act).toContain('"ep-1"');
    expect(act).toContain("[3 - 1]");
    expect(act).toContain('{"kind":"click"}');
  });
});

describe("parsePageView", () => {
  it("validates the mark result and drops malformed rows", () => {
    const view = parsePageView(JSON.stringify({
      epoch: "ep-1", title: "Запись", url: "https://x.ru/book",
      elements: [
        { n: 1, role: "link", text: "Записаться" },
        { n: 2, role: "textbox", text: "Телефон", value: "+7", state: ["required"] },
        { n: 3, role: "checkbox", text: "Мужская стрижка", state: ["checked"] },
        { n: "x", role: "button" },
        "junk",
      ],
    }));
    expect(view.epoch).toBe("ep-1");
    expect(view).toMatchObject({ stateHash: 0, textHash: 0 });
    expect(parsePageView(JSON.stringify({ elements: [], epoch: "e", title: "x".repeat(300), url: "https://x.ru" })).title).toHaveLength(200);
    expect(parsePageView(JSON.stringify({ elements: [], epoch: "e", stateHash: 7, textHash: 9, url: "https://x.ru" }))).toMatchObject({ stateHash: 7, textHash: 9 });
    expect(view.elements).toHaveLength(3);
    expect(view.elements[2]).toEqual({ n: 3, role: "checkbox", state: ["checked"], text: "Мужская стрижка", value: null });
  });

  it("rejects a result without epoch or url", () => {
    expect(() => parsePageView("{}")).toThrow(/AGENT_BROWSER_VIEW_INVALID/u);
    expect(() => parsePageView("not json")).toThrow(/AGENT_BROWSER_VIEW_INVALID/u);
  });
});

describe("renderElements and viewHash", () => {
  const view = parsePageView(JSON.stringify({
    epoch: "e", title: "t", url: "https://x.ru/",
    elements: [
      { n: 1, role: "textbox", text: "Имя", value: "Илья" },
      { n: 2, role: "checkbox", text: "Стрижка", state: ["checked"] },
      { n: 3, role: "button", text: "Продолжить", state: ["disabled"] },
    ],
  }));

  it("renders one line per element with what the model decides on", () => {
    expect(renderElements(view)).toBe([
      "[1] textbox Имя · Илья",
      "[2] checkbox Стрижка (checked)",
      "[3] button Продолжить (disabled)",
    ].join("\n"));
  });

  it("hashes content, not numbering or epoch", () => {
    const renumbered = parsePageView(JSON.stringify({ ...view, epoch: "f", elements: view.elements.map((e, i) => ({ ...e, n: i + 10 })) }));
    const toggled = parsePageView(JSON.stringify({ ...view, elements: view.elements.map((e) => e.n === 2 ? { ...e, state: [] } : e) }));
    expect(viewHash(renumbered)).toBe(viewHash(view));
    expect(viewHash(toggled)).not.toBe(viewHash(view));
  });
});
