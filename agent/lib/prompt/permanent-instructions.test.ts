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
  });

  it("stays materially smaller than the mode-agnostic plus mode-specific whole", async () => {
    const instructions = await permanentInstructions();

    // The permanent core must not silently grow back into a full three-mode rulebook.
    expect(instructions.length).toBeLessThan(20_000);
  });
});
