/**
 * Form profile tests.
 *
 * Constructs covered:
 * - A value reaches a page only for an allowed field on an allowed domain; run data wins.
 * - Card and password fields are refused at parse time and at resolve time.
 * - Field labels map to profile field names.
 */
import { describe, expect, it } from "vitest";

import { fieldForElement, parseFormProfile, resolveFieldValue, serializeFormProfile, upsertProfileField } from "./form-profile.js";

const PROFILE = parseFormProfile(JSON.stringify({
  name: { domains: ["*"], value: "Илья" },
  phone: { domains: ["yclients.com", "dikidi.net"], value: "+79160000000" },
}));

describe("resolveFieldValue", () => {
  it("substitutes only an allowed field on an allowed domain", () => {
    expect(resolveFieldValue({ allowedFields: ["phone", "name"], domain: "n123.yclients.com", extraData: {}, field: "phone", profile: PROFILE })).toBe("+79160000000");
    expect(resolveFieldValue({ allowedFields: ["phone"], domain: "goodman.ru", extraData: {}, field: "phone", profile: PROFILE })).toBeNull();
    expect(resolveFieldValue({ allowedFields: ["name"], domain: "dikidi.net", extraData: {}, field: "phone", profile: PROFILE })).toBeNull();
    expect(resolveFieldValue({ allowedFields: ["name"], domain: "goodman.ru", extraData: {}, field: "name", profile: PROFILE })).toBe("Илья");
  });

  it("prefers explicit run data over the profile and never fills card fields", () => {
    expect(resolveFieldValue({ allowedFields: ["phone"], domain: "goodman.ru", extraData: { phone: "+79990000000" }, field: "phone", profile: PROFILE })).toBe("+79990000000");
    expect(resolveFieldValue({ allowedFields: ["cvc"], domain: "goodman.ru", extraData: { cvc: "123" }, field: "cvc", profile: PROFILE })).toBeNull();
  });

  it("rejects a profile with a card field or without domains", () => {
    expect(() => parseFormProfile(JSON.stringify({ cardNumber: { domains: ["*"], value: "4" } }))).toThrowError(/AGENT_BROWSER_TASK_PROFILE_INVALID/u);
    expect(() => parseFormProfile(JSON.stringify({ phone: { value: "+7" } }))).toThrowError(/AGENT_BROWSER_TASK_PROFILE_INVALID/u);
    expect(() => parseFormProfile("не json")).toThrowError(/AGENT_BROWSER_TASK_PROFILE_INVALID/u);
  });
});

describe("fieldForElement", () => {
  it.each([["Телефон", "phone"], ["Номер телефона", "phone"], ["Мобильный телефон*", "phone"], ["Имя", "name"], ["Ваше имя*", "name"], ["Введите e-mail", "email"], ["Комментарий", null], ["Дата", null]])
    ("maps %s to %s", (name, field) => {
      expect(fieldForElement({ name, role: "textbox" })).toBe(field);
    });
});

describe("upsertProfileField and serializeFormProfile", () => {
  it("adds a field bound to its domains and merges domains on repeat", () => {
    const once = upsertProfileField({}, { domains: ["yclients.ru"], field: "phone", value: "+79160000000" });
    expect(once.phone).toEqual({ domains: ["yclients.ru"], value: "+79160000000" });
    const twice = upsertProfileField(once, { domains: ["dikidi.net", "yclients.ru"], field: "phone", value: "+79160000000" });
    expect(twice.phone!.domains).toEqual(["yclients.ru", "dikidi.net"]);
    const changed = upsertProfileField(twice, { domains: ["*"], field: "phone", value: "+79990000000" });
    expect(changed.phone).toEqual({ domains: ["*"], value: "+79990000000" });
  });

  it("refuses card fields, empty values and empty domains", () => {
    expect(() => upsertProfileField({}, { domains: ["*"], field: "cvc", value: "123" })).toThrowError(/AGENT_BROWSER_TASK_PROFILE_INVALID/u);
    expect(() => upsertProfileField({}, { domains: [], field: "name", value: "Илья" })).toThrowError(/AGENT_BROWSER_TASK_PROFILE_INVALID/u);
    expect(() => upsertProfileField({}, { domains: ["*"], field: "name", value: " " })).toThrowError(/AGENT_BROWSER_TASK_PROFILE_INVALID/u);
  });

  it("serializes to the file shape that parseFormProfile reads back", () => {
    const profile = upsertProfileField({}, { domains: ["*"], field: "name", value: "Илья" });
    expect(parseFormProfile(serializeFormProfile(profile))).toEqual(profile);
    expect(serializeFormProfile(profile)).toContain("\n");
  });
});
