/**
 * The `telegram-widgets` skill: how Mia builds a Telegram widget card.
 *
 * Exports:
 * - `TELEGRAM_WIDGET_SKILL_NAME`, `TELEGRAM_WIDGET_SKILL_DEFINITION`: the dynamic skill package.
 * - `TELEGRAM_WIDGET_TEMPLATES`: the template files of the package, by package path.
 *
 * Key constructs:
 * - The package lives in `config/capability-skills/telegram-widgets/`, outside `agent/skills`:
 *   static discovery would show it in every chat, while it must appear only together with the
 *   `send_widget` tool (trusted chats, switch on, never a subagent).
 * - The source is found from the working directory first, then next to the module, as the analyst
 *   packages are: an Eve build bundle and the tests run from different places.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineSkill, type SkillDefinition } from "eve/skills";

export const TELEGRAM_WIDGET_SKILL_NAME = "telegram-widgets" as const;

function packageRoot(): string {
  const fromCwd = resolve("config/capability-skills/telegram-widgets");
  return existsSync(`${fromCwd}/instructions.md`)
    ? fromCwd
    : fileURLToPath(
        new URL("../../../config/capability-skills/telegram-widgets/", import.meta.url),
      );
}

const root = packageRoot();

export const TELEGRAM_WIDGET_TEMPLATES: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(`${root}/templates`)
    .filter((name) => name.endsWith(".html"))
    .sort()
    .map((name) => [`templates/${name}`, readFileSync(`${root}/templates/${name}`, "utf8")]),
);

export const TELEGRAM_WIDGET_SKILL_DEFINITION: SkillDefinition = defineSkill({
  description:
    "Сборка виджета Telegram — карточки из HTML прямо в сообщении (сводка с цифрами, таблица, вкладки, полоски, график): что она умеет, шаблоны, лимит 4 КБ и отправка через send_widget.",
  files: { ...TELEGRAM_WIDGET_TEMPLATES },
  markdown: readFileSync(`${root}/instructions.md`, "utf8"),
});
