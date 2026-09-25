/**
 * What one look at a page gives the model: numbered elements bound to an epoch.
 *
 * Exports:
 * - `PageView`, `PageElement`: the validated result of the mark script.
 * - `parsePageView`: validates the script's JSON; a malformed row is dropped, a malformed result
 *   is an error.
 * - `renderElements`: one line per element for the model.
 * - `viewHash`: content hash without numbering, so a re-render with the same content matches and
 *   any change of text, value or state does not.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { AppError } from "../app-error.js";

const elementSchema = z.object({
  n: z.number().int().positive(),
  role: z.string().min(1).max(40),
  state: z.array(z.string().max(20)).max(8).default([]),
  text: z.string().max(60).default(""),
  value: z.string().max(60).nullable().default(null),
});
const viewSchema = z.object({
  elements: z.array(z.unknown()),
  epoch: z.string().min(1).max(64),
  textHash: z.number().int().default(0),
  title: z.string().max(200).default(""),
  url: z.string().min(1).max(2_048),
});

export type PageElement = z.infer<typeof elementSchema>;
export interface PageView { elements: PageElement[]; epoch: string; textHash: number; title: string; url: string; }

export function parsePageView(json: string): PageView {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new AppError("AGENT_BROWSER_VIEW_INVALID", "Разметка страницы не читается как JSON");
  }
  const parsed = viewSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("AGENT_BROWSER_VIEW_INVALID", "Разметка страницы не соответствует форме");
  const elements = parsed.data.elements.flatMap((row) => {
    const element = elementSchema.safeParse(row);
    return element.success ? [element.data] : [];
  });
  return { elements, epoch: parsed.data.epoch, textHash: parsed.data.textHash, title: parsed.data.title, url: parsed.data.url };
}

export function renderElements(view: PageView): string {
  return view.elements.map((e) => `[${e.n}] ${e.role} ${e.text}`
    + `${e.value !== null && e.value !== "" ? ` · ${e.value}` : ""}`
    + `${e.state.length > 0 ? ` (${e.state.join(", ")})` : ""}`).join("\n");
}

export function viewHash(view: PageView): string {
  const hash = createHash("sha256").update(view.url).update("\u0000").update(view.title);
  for (const e of view.elements) hash.update(`\u0001${e.role}\u0002${e.text}\u0002${e.value ?? ""}\u0002${e.state.join(",")}`);
  return hash.digest("hex");
}
