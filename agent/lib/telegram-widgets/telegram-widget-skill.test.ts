/**
 * The `telegram-widgets` skill package.
 *
 * Constructs covered:
 * - The package carries the instructions and every template under `templates/`.
 * - Every template passes the same check `send_widget` runs, with no error and no warning, and
 *   leaves at least half of the 4 KB budget to the data, the default style kit included: a template
 *   that breaks or drops markup teaches the model to send broken cards.
 * - Every template starts from the same style kit, so a card copied from any of them looks the same.
 */
import { describe, expect, it } from "vitest";

import { measureTelegramWidget } from "./telegram-widget-limits.js";
import { lintTelegramWidget } from "./telegram-widget-lint.js";
import { TELEGRAM_WIDGET_SKILL_DEFINITION, TELEGRAM_WIDGET_TEMPLATES } from "./telegram-widget-skill.js";

describe("telegram-widgets skill", () => {
  it("carries the instructions and the templates", () => {
    expect(TELEGRAM_WIDGET_SKILL_DEFINITION.markdown).toMatch(/send_widget/u);
    expect(Object.keys(TELEGRAM_WIDGET_TEMPLATES).sort()).toEqual(["templates/bars.html", "templates/summary.html", "templates/tabs.html"]);
  });

  it("ships templates that pass the send_widget check cleanly and leave half the budget to the data", () => {
    for (const [path, html] of Object.entries(TELEGRAM_WIDGET_TEMPLATES)) {
      expect(lintTelegramWidget(html, { allowLinks: false }), path).toEqual({ errors: [], links: [], warnings: [] });
      expect(measureTelegramWidget(html).compressedBytes, path).toBeLessThan(2_048);
    }
  });

  it("builds every template on the same default style kit", () => {
    const kit = (html: string) => /<style>\n([\s\S]*?\.ft\{[^}]*\})/u.exec(html)?.[1];
    const kits = Object.values(TELEGRAM_WIDGET_TEMPLATES).map(kit);
    expect(kits[0]).toMatch(/\.t-food\{/u);
    for (const other of kits) expect(other).toBe(kits[0]);
  });
});
