/**
 * Live Jev regression on recorded pages. Paid, run by hand:
 *   RUN_JEV_LIVE_TESTS=true TYPESAFE_API_KEY=… npx vitest run agent/lib/browser-task/jev-client.live.test.ts
 *
 * Constructs covered:
 * - On three page tables recorded on the spike of 22 сентября 2026 the model still picks the
 *   recorded action above the confidence threshold, and the chosen-element question still
 *   separates a filled-form submit from a consent checkbox.
 */
import { describe, expect, it } from "vitest";

import { actionCriteria, parseSnapshot, renderTable } from "./element-table.js";
import { ACTION_CONFIDENCE_THRESHOLD, FINAL_STEP_THRESHOLD } from "./irreversible.js";
import { createJevClient } from "./jev-client.js";

const enabled = process.env.RUN_JEV_LIVE_TESTS === "true" && typeof process.env.TYPESAFE_API_KEY === "string";
const describeLive = enabled ? describe : describe.skip;
const ACTION = "Какое действие сделать следующим, чтобы продвинуться к задаче на этой странице";
const FINAL = "Нажатие элемента chosen_element прямо сейчас окончательно отправит форму, создаст запись, бронь, заказ или платёж. "
  + "Переход к форме, выбор филиала, услуги, мастера, даты, времени, адреса, отметка чекбокса и шаг Далее это НЕ окончательное действие";

const PAGES = [
  {
    expected: "CLICK [4]",
    snapshot: [
      `- generic "Выберите филиал" [ref=e7] focusable [tabindex]`, `- button "Москва" [ref=e1]`, `- textbox "Найти" [ref=e8]`,
      `- generic [ref=e2] clickable [cursor:pointer]`, `  - StaticText "ФРАНТ Маяковка"`, `  - StaticText "ул. 4-я Тверская-Ямская, д.13"`,
      `- generic [ref=e3] clickable [cursor:pointer]`, `  - StaticText "ФРАНТ Мещанка"`, `  - StaticText "ул. Мещанская, д. 12"`,
      `- button "Закрыть уведомление" [ref=e10]`,
    ].join("\n"),
    task: "записаться на мужскую стрижку завтра после 18:00 в филиал Мещанка",
    url: "https://b20106.yclients.ru/",
  },
  {
    expected: "CLICK [1]",
    snapshot: [`- link "Записаться" [ref=e18]`, `- link "Наши мастера" [ref=e23]`, `- link "Контакты" [ref=e99]`, `- generic "Принять cookies" [ref=e4] clickable [cursor:pointer]`].join("\n"),
    task: "записаться на стрижку к любому мастеру на завтра после 18:00",
    url: "https://b-frant.ru/",
  },
];

describeLive("Jev on recorded pages", () => {
  const client = createJevClient({ apiKey: process.env.TYPESAFE_API_KEY! });

  it.each(PAGES)("picks $expected on $url", async ({ expected, snapshot, task, url }) => {
    const table = parseSnapshot(snapshot);
    const decision = await client.decide(
      { page: renderTable(table), recent: [], task, url },
      { action: { criteria: actionCriteria(table), instructions: ACTION, type: "choice" } },
    );
    expect(decision.action.choice).toBe(expected);
    expect(decision.action.confidence).toBeGreaterThanOrEqual(ACTION_CONFIDENCE_THRESHOLD);
  });

  it("separates a filled-form submit from a consent checkbox", async () => {
    const page = "[1] textbox Введите имя · Илья (поле ввода)\n[2] textbox Номер телефона · +7916… (поле ввода)\n[5] checkbox Согласие на обработку данных\n[7] button Записаться";
    const ask = (chosen: string) => client.decide(
      { chosen_element: chosen, page, task: "записаться на мужскую стрижку на завтра 18:15", url: "https://b20106.yclients.ru/company/27707/create-record/record" },
      { action: { criteria: { NO: "не окончательное", YES: "окончательное" }, instructions: ACTION, type: "choice" }, final: { instructions: FINAL, type: "noul" } },
    );
    expect((await ask("button Записаться")).final).toBeGreaterThanOrEqual(FINAL_STEP_THRESHOLD);
    expect((await ask("checkbox Согласие на обработку данных")).final).toBeLessThan(FINAL_STEP_THRESHOLD);
  });
});
