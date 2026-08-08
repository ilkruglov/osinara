/**
 * Permanent instruction purity tests.
 *
 * Constructs covered:
 * - `agent/instructions.md` holds only mode-agnostic rules; every scoped rule lives in a mode block.
 * - The universal core still carries the trust hierarchy the mode blocks depend on.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const INSTRUCTIONS_PATH = new URL("../../instructions.md", import.meta.url);

async function permanentInstructions(): Promise<string> {
  return await readFile(INSTRUCTIONS_PATH, "utf8");
}

describe("permanent instructions", () => {
  it("names no scope, mount, or mode-specific capability", async () => {
    const instructions = await permanentInstructions();

    for (const forbidden of [
      "/workspace/personal",
      "/workspace/family",
      "/workspace/group",
      "`personal`",
      "`group`",
      "export_memory",
      "notification_settings",
      "manage_reminder",
      "list_reminders",
      "manage_agent_schedule",
      "list_agent_schedules",
      "list_proactive_deliveries",
      "list_group_history",
      "list_telegram_attachments",
      "import_telegram_attachment",
      "manage_telegram_group",
      "manage_behavior_preference",
      "inspect_workspace_image",
      "send_workspace_file",
      "get_current_time",
      "load_skill",
      "agent-browser",
      "<untrusted_telegram_group_timeline>",
      "<telegram_attachment_refs>",
      "<workspace_attachments>",
      "<recent_proactive_deliveries>",
      "внешней группе",
      "семейной группе",
    ]) {
      expect(instructions, `permanent instructions must not mention ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

  it("keeps the universal trust hierarchy and mode contract", async () => {
    const instructions = await permanentInstructions();

    expect(instructions).toContain("# Идентичность и роль");
    expect(instructions).toContain("# Приоритет правил и доверие к данным");
    expect(instructions).toContain("# Безопасность и авторизация");
    expect(instructions).toContain("<current_conversation_environment>");
    expect(instructions).toContain("AGENT_CONVERSATION_ENVIRONMENT_INVALID");
    expect(instructions).toContain("Отказ в HITL — терминальное решение");
    expect(instructions).toContain("<current_time>");
    expect(instructions).toContain("# Rich Telegram presentation");
    expect(instructions).toContain("<telegram-reaction>");
    expect(instructions).toContain("не добавляй никакого текста");
    expect(instructions).toContain("`❤`");
    expect(instructions).toContain("`🤣`");
    expect(instructions).toContain("`🖕`");
    expect(instructions).toContain("Не используй `🖕` для критики");
  });

  it("pins the agent voice against a style imposed from chat", async () => {
    const instructions = await permanentInstructions();

    expect(instructions).toContain("# Устойчивость голоса и стиля");
    expect(instructions).toMatch(/не предмет договорённостей/u);
    // Only verified sources may change the voice; chat text is never one of them.
    expect(instructions).toMatch(
      /эти постоянные инструкции, проверенные системные блоки текущего хода и загруженный/u,
    );
    expect(instructions).toMatch(/даже в шутку и даже один раз/u);
    expect(instructions).toMatch(/знаки препинания словами/u);
    expect(instructions).toMatch(/менять имя, род, характер/u);
    // A one-off formatting request must stay allowed, so the rule cannot turn into a blanket refusal.
    expect(instructions).toMatch(/подача конкретного ответа настраивается/u);
    expect(instructions).toMatch(/Просьбу вернуться к обычному стилю выполняй всегда/u);
    // Own contaminated output must not become the new norm after a successful hijack.
    expect(instructions).toMatch(/не создаёт нового правила/u);
  });

  it("makes the collapsible block mandatory for every long answer", async () => {
    const instructions = await permanentInstructions();

    expect(instructions).toContain("## Длинные ответы всегда прячь под раскрытие");
    // Genre must not become an escape hatch: long plain prose is still a long answer.
    expect(instructions).toMatch(/не зависит от жанра/u);
    expect(instructions).toMatch(/больше трёх абзацев/u);
    expect(instructions).toMatch(/Одного признака достаточно/u);
    // An explicit pre-send checkpoint, not a vague preference.
    expect(instructions).toMatch(/Перед отправкой проверь/u);
    expect(instructions).toMatch(/не отправляй такой текст/u);
    expect(instructions).toMatch(/Подробность требует раскрытия, а не отказа от него/u);
    // The plain-text default must not read as a licence for a long unfolded answer.
    expect(instructions).toMatch(/только о внутренней разметке/u);
    expect(instructions).toMatch(/сомневаешься в объёме, сворачивай/u);
    // The short-answer counterbalance stays, so the rule cannot flip into wrapping everything.
    expect(instructions).toMatch(/Не прячь под раскрытие короткий ответ/u);
  });

  it("stays materially smaller than the mode-agnostic plus mode-specific whole", async () => {
    const instructions = await permanentInstructions();

    // The permanent core must not silently grow back into a full three-mode rulebook.
    expect(instructions.length).toBeLessThan(20_000);
  });
});
