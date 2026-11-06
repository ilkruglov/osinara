/**
 * The `telegram-widgets` skill package.
 *
 * Constructs covered:
 * - The package carries the instructions and every template under `templates/`.
 * - Every template passes the same check `send_widget` runs, with no error and no warning, and
 *   leaves most of the 4 KB budget to the data: a template that breaks or drops markup teaches the
 *   model to send broken cards.
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

  it("ships templates that pass the send_widget check cleanly and stay well under the budget", () => {
    for (const [path, html] of Object.entries(TELEGRAM_WIDGET_TEMPLATES)) {
      expect(lintTelegramWidget(html, { allowLinks: false }), path).toEqual({ errors: [], links: [], warnings: [] });
      expect(measureTelegramWidget(html).compressedBytes, path).toBeLessThan(1_500);
    }
  });
});
