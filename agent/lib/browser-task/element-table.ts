/**
 * Element table for browser_task: the accessibility snapshot of agent-browser as a numbered list.
 *
 * Exports:
 * - `parseSnapshot`: full `snapshot` text → elements with refs, roles, names and operations.
 * - `renderTable`, `actionCriteria`, `parseChoice`, `tableHash`: the Jev-facing views of it.
 *
 * Key constructs:
 * - The full snapshot, not the interactive one: the YClients widget shows 2 of 10 controls
 *   under `-i -c` because its cards are unnamed generics. Names come from nested text.
 * - Text leaves without refs are choices too: calendar days and time slots live in shadow DOM
 *   and reach the tree only as StaticText. Field labels are dropped so Jev is not offered the
 *   word "Телефон" next to the textbox "Телефон".
 * - 120 elements at most: at 300 the spike measured Jev at 5 to 7 seconds instead of under one.
 */
import { createHash } from "node:crypto";

export type Operation = "CLICK" | "ENTER" | "SELECT" | "TEXT" | "TYPE_TEXT";
export interface TableElement {
  index: number;
  ref: string | null;
  role: string;
  name: string;
  value: string | null;
  operations: Operation[];
}
export interface ElementTable { elements: TableElement[]; }
export type ActionOption =
  | { kind: "element"; operation: Operation; index: number }
  | { kind: "BLOCKED" } | { kind: "DONE" } | { kind: "SCROLL_DOWN" } | { kind: "SCROLL_UP" } | { kind: "WAIT" };

export const TABLE_MAX_ELEMENTS = 120;
export const NAME_MAX_CHARACTERS = 60;
const TEXT_LEAF_MAX_CHARACTERS = 40;
export const STATIC_OPTIONS: Readonly<Record<string, string>> = {
  BLOCKED: "без человека продвинуться нельзя",
  DONE: "задача уже выполнена на этой странице",
  SCROLL_DOWN: "прокрутить вниз, чтобы увидеть больше",
  SCROLL_UP: "прокрутить вверх",
  WAIT: "подождать загрузку страницы",
};

const LINE = /^-\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*(?:\[([^\]]*)\])?(.*)$/u;
const TYPING_ROLES = new Set(["combobox", "searchbox", "spinbutton", "textbox"]);
const CLICK_ROLES = new Set(["button", "cell", "checkbox", "combobox", "link", "listbox", "listitem", "menuitem", "radio", "row", "switch", "tab"]);
const STATIC_ROLES = new Set(["heading", "image", "img", "list", "paragraph", "separator", "table", "text"]);

interface Line { indent: number; body: string; }

function lines(text: string): Line[] {
  return text.split("\n")
    .map((raw) => ({ body: raw.trim(), indent: raw.length - raw.trimStart().length }))
    .filter((line) => line.body.startsWith("- "));
}

const labelKey = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function unescape(value: string): string {
  return value.replace(/\\"/gu, "\"").replace(/\s+/gu, " ").trim();
}

/** Text nested under a ref element names it and is therefore not a separate choice. */
function nameFromDescendants(all: Line[], at: number, consumed: Set<string>): string {
  const parts: string[] = [];
  for (let j = at + 1; j < all.length && all[j]!.indent > all[at]!.indent; j++) {
    const match = /^-\s+\S+\s+"((?:[^"\\]|\\.)*)"/u.exec(all[j]!.body);
    if (!match) continue;
    const part = unescape(match[1]!);
    consumed.add(labelKey(part));
    if (parts.join(" · ").length < NAME_MAX_CHARACTERS) parts.push(part);
  }
  return parts.join(" · ").slice(0, NAME_MAX_CHARACTERS);
}

function operationsFor(role: string, tail: string): Operation[] {
  const operations: Operation[] = [];
  if (role === "Iframe") return ["ENTER"];
  if (role === "option") return ["SELECT"];
  if (TYPING_ROLES.has(role)) operations.push("TYPE_TEXT");
  // A list only opens on click; SELECT belongs to its options, which find their list themselves.
  if (CLICK_ROLES.has(role) || (!STATIC_ROLES.has(role) && /clickable/u.test(tail))) operations.push("CLICK");
  return operations;
}

export function parseSnapshot(text: string): ElementTable {
  const all = lines(text);
  const elements: TableElement[] = [];
  const known = new Set<string>();
  for (let k = 0; k < all.length && elements.length < TABLE_MAX_ELEMENTS; k++) {
    const match = LINE.exec(all[k]!.body);
    if (!match) continue;
    const [, role, rawName, attrs = "", tail = ""] = match;
    const ref = /(?:^|[\s,])ref=(e\d+)/u.exec(attrs)?.[1];
    if (!ref) continue;
    const operations = operationsFor(role!, tail);
    if (operations.length === 0) continue;
    let name = rawName === undefined ? nameFromDescendants(all, k, known) : unescape(rawName).slice(0, NAME_MAX_CHARACTERS);
    if (!name) {
      if (!operations.includes("ENTER")) continue;
      name = "(фрейм)";
    }
    const value = /value="((?:[^"\\]|\\.)*)"/u.exec(tail)?.[1] ?? null;
    elements.push({ index: elements.length + 1, name, operations, ref, role: role!, value: value === null ? null : unescape(value) });
  }
  for (const e of elements) known.add(labelKey(e.name));
  for (const line of all) {
    if (elements.length >= TABLE_MAX_ELEMENTS) break;
    const match = /^-\s+StaticText\s+"((?:[^"\\]|\\.)*)"$/u.exec(line.body);
    if (!match) continue;
    const name = unescape(match[1]!);
    const key = labelKey(name);
    if (!name || name.length > TEXT_LEAF_MAX_CHARACTERS || !key || known.has(key)) continue;
    known.add(key);
    elements.push({ index: elements.length + 1, name, operations: ["TEXT"], ref: null, role: "text", value: null });
  }
  return { elements };
}

export function renderTable(table: ElementTable): string {
  return table.elements
    .map((e) => `[${e.index}] ${e.role === "text" ? "вариант" : e.role} ${e.name}`
      + `${e.value !== null && e.value !== "" ? ` · ${e.value}` : ""}`
      + `${e.operations.includes("TYPE_TEXT") ? " (поле ввода)" : ""}`)
    .join("\n");
}

export function tableHash(table: ElementTable): string {
  const hash = createHash("sha256");
  for (const e of table.elements) hash.update(`${e.ref ?? ""}|${e.role}|${e.name}|${e.value ?? ""}\n`);
  return hash.digest("hex");
}

export function actionCriteria(table: ElementTable): Record<string, string> {
  const criteria: Record<string, string> = { ...STATIC_OPTIONS };
  for (const e of table.elements) {
    for (const operation of e.operations) {
      criteria[`${operation} [${e.index}]`] = operation === "ENTER"
        ? `войти во встроенный виджет ${e.name}`
        : operation === "TEXT" ? `выбрать ${e.name}` : `${e.role} ${e.name}`;
    }
  }
  return criteria;
}

export function parseChoice(choice: string, table: ElementTable): ActionOption | null {
  if (choice in STATIC_OPTIONS) return { kind: choice as Exclude<ActionOption, { kind: "element" }>["kind"] };
  const match = /^(CLICK|ENTER|SELECT|TEXT|TYPE_TEXT) \[(\d+)\]$/u.exec(choice);
  if (!match) return null;
  const element = table.elements[Number(match[2]) - 1];
  if (!element || !element.operations.includes(match[1] as Operation)) return null;
  return { index: element.index, kind: "element", operation: match[1] as Operation };
}
