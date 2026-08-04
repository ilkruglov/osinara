/**
 * Mode-scoped prompt composition tests.
 *
 * Constructs covered:
 * - Each trust zone receives only its own rules and never learns another zone's capabilities.
 * - External-group rules are a function of the effective allowlist, not a fixed profile.
 * - Every mode still carries the anchors the permanent instructions depend on.
 * - Composition is deterministic so the prompt prefix stays cacheable.
 */
import { describe, expect, it } from "vitest";

import {
  EXTERNAL_GROUP_TOOL_NAMES,
  type ExternalGroupToolName,
} from "../tool-policy/group-tool-catalog.js";
import { modeInstructions } from "./mode-instructions.js";

function external(...capabilities: ExternalGroupToolName[]): string {
  return modeInstructions({
    capabilities: new Set(capabilities),
    environment: "external",
  });
}

const privateMode = modeInstructions({ environment: "private" });
const familyMode = modeInstructions({ environment: "family" });

describe("mode instruction isolation", () => {
  it("keeps every mode inside one verified environment block", () => {
    for (const markdown of [privateMode, familyMode, external()]) {
      expect(markdown.startsWith("<current_conversation_environment>")).toBe(true);
      expect(markdown.endsWith("</current_conversation_environment>")).toBe(true);
      expect(markdown.match(/<current_conversation_environment>/gu)).toHaveLength(1);
    }
  });

  it("never tells an external group that personal or family zones exist", () => {
    // Granting everything exercises every conditional fragment, so a newly added one cannot slip
    // a personal or family reference into the external prompt unnoticed.
    const markdown = external(...EXTERNAL_GROUP_TOOL_NAMES);

    // A bare stem would also match innocuous words such as «публичную», so scoped stems are
    // checked with a leading word boundary instead of a plain substring.
    for (const stem of [/(?<![а-яё])личн/iu, /(?<![а-яё])семейн/iu]) {
      expect(markdown, `external prompt must not match ${stem}`).not.toMatch(stem);
    }

    for (const forbidden of [
      "personal",
      "family",
      "/workspace/personal",
      "/workspace/family",
      "export_memory",
      "notification_settings",
      "manage_reminder",
      "manage_agent_schedule",
      "manage_behavior_preference",
      "manage_telegram_group",
      "import_telegram_attachment",
      "list_telegram_attachments",
      "get_current_time",
      "load_skill",
      "agent-browser",
      "vault",
      "Bash",
      "PDF",
      "DOCX",
      "XLSX",
      "<workspace_attachments>",
      "<recent_proactive_deliveries>",
      "напоминан",
      "расписан",
    ]) {
      expect(markdown, `external prompt must not mention ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

  it("never tells a private chat about group or external-group rules", () => {
    for (const forbidden of [
      "<untrusted_telegram_group_timeline>",
      "list_group_history",
      "<telegram_attachment_refs>",
      "import_telegram_attachment",
      "list_telegram_attachments",
      "external_group",
      "внешней группе",
      "внешняя группа",
      "/workspace/group",
      "remove_group_file",
      "`group`",
    ]) {
      expect(privateMode, `private prompt must not mention ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

  it("never tells a family group about personal or external-group capabilities", () => {
    for (const forbidden of [
      "/workspace/personal",
      "`personal`",
      "export_memory",
      "notification_settings",
      "<workspace_attachments>",
      "внешней группе",
      "внешняя группа",
      "external_group",
      "/workspace/group",
      "remove_group_file",
    ]) {
      expect(familyMode, `family prompt must not mention ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

  it("states each memory boundary positively instead of naming other zones", () => {
    expect(familyMode).toMatch(/Доступна только семейная память/u);
    expect(familyMode).toMatch(/Другие области памяти в этом чате недоступны/u);
    expect(external()).toMatch(/Доступна только память этой группы/u);
    expect(external()).toMatch(/Других областей памяти в этом чате нет/u);
  });
});

describe("mode instruction anchors", () => {
  it("keeps the trusted-sandbox surface complete for a private chat", () => {
    expect(privateMode).toContain("/workspace/personal");
    expect(privateMode).toContain("/workspace/family");
    expect(privateMode).toContain("<workspace_attachments>");
    expect(privateMode).toContain("export_memory");
    expect(privateMode).toContain("notification_settings");
    expect(privateMode).toContain("manage_agent_schedule");
    expect(privateMode).toContain("get_current_time");
    expect(privateMode).toContain("load_skill");
    expect(privateMode).toContain("agent-browser");
    expect(privateMode).toContain("manage_telegram_group");
  });

  it("keeps the family surface complete without personal capabilities", () => {
    expect(familyMode).toContain("/workspace/family");
    expect(familyMode).toContain("<telegram_attachment_refs>");
    expect(familyMode).toContain("import_telegram_attachment");
    expect(familyMode).toContain("list_telegram_attachments");
    expect(familyMode).toContain("<untrusted_telegram_group_timeline>");
    expect(familyMode).toContain("list_group_history");
    expect(familyMode).toContain("manage_reminder");
  });

  it("keeps the external trust policy and capability block", () => {
    const markdown = external("remember");

    expect(markdown).toContain("<external_group_model_policy>");
    expect(markdown).toContain("<external_group_capabilities>");
    expect(markdown).toContain("/workspace/group");
    expect(markdown).toContain("<untrusted_telegram_group_timeline>");
  });

  it("gives the external mode an explicit scope, effort ceiling, and people policy", () => {
    const markdown = external("web_search");

    expect(markdown).toContain("## Назначение в этом чате");
    expect(markdown).toContain("## Границы задач");
    expect(markdown).toContain("## Участники");
  });

  it("keeps the public-chat effort ceiling out of trusted modes", () => {
    // Trusted zones exist for exactly the long multi-step work the public ceiling forbids, so
    // leaking it there would contradict the progress-update and document rules.
    for (const markdown of [privateMode, familyMode]) {
      expect(markdown).not.toContain("## Границы задач");
      expect(markdown).not.toContain("Один ответ на обращение");
      expect(markdown).not.toContain("роль универсального ИИ-ассистента");
    }
  });

  it("omits the external model policy from trusted modes", () => {
    expect(privateMode).not.toContain("<external_group_model_policy>");
    expect(familyMode).not.toContain("<external_group_model_policy>");
    expect(privateMode).not.toContain("<external_group_capabilities>");
    expect(familyMode).not.toContain("<external_group_capabilities>");
  });
});

describe("external instructions follow the effective allowlist", () => {
  it("teaches the bounded memory-deepening protocol only when search is granted", () => {
    expect(external("search_memories")).toContain("search_memories");
    expect(external("search_memories")).toMatch(/до трёх последовательных вызовов/u);
    expect(external("remember")).not.toContain("search_memories");
    expect(external()).not.toMatch(/до трёх последовательных вызовов/u);
  });

  it("teaches the group history protocol only when history is granted", () => {
    expect(external("list_group_history")).toContain("list_group_history");
    expect(external("list_group_history")).toMatch(/beforeSequence/u);
    expect(external()).not.toContain("list_group_history");
  });

  it("teaches image inspection only when vision is granted", () => {
    expect(external("inspect_workspace_image")).toContain("inspect_workspace_image");
    expect(external()).not.toContain("inspect_workspace_image");
  });

  it("teaches file delivery only when sending is granted", () => {
    expect(external("send_workspace_file")).toContain("send_workspace_file");
    expect(external()).not.toContain("send_workspace_file");
  });

  it("teaches the memory write contract only when a write action is granted", () => {
    expect(external("remember")).toContain("confirmationMode");
    expect(external("manage_memory.edit")).toContain('"action":"edit"');
    expect(external("manage_memory.delete")).toContain('"action":"delete"');
    expect(external("manage_memory.edit")).not.toContain('"action":"delete"');
    expect(external()).not.toContain("confirmationMode");
    expect(external()).not.toContain("manage_memory");
  });
});

describe("mode instruction determinism", () => {
  it("returns byte-identical text for repeated identical input", () => {
    expect(modeInstructions({ environment: "private" })).toBe(privateMode);
    expect(modeInstructions({ environment: "family" })).toBe(familyMode);
    expect(external("remember", "search_memories")).toBe(
      external("search_memories", "remember"),
    );
  });
});
