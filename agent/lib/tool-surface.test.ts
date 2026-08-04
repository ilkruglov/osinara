/**
 * Agent capability surface regression tests.
 *
 * Constructs:
 * - `agent/tools` holds only the dynamic capability resolver; implementations live in lib.
 * - Exact application tool-module allowlist after CRUD consolidation.
 * - Exact native skill package directories, with no TypeScript pseudo-skills.
 * - Opt-in tone skills advertise explicit-request activation only.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const AGENT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXPECTED_TOOL_MODULES = [
  "export_memory.ts",
  "get_current_time.ts",
  "import_telegram_attachment.ts",
  "inspect_workspace_image.ts",
  "list_agent_schedules.ts",
  "list_group_history.ts",
  "list_memories.ts",
  "list_pending_family_invitations.ts",
  "list_proactive_deliveries.ts",
  "list_reminders.ts",
  "list_telegram_attachments.ts",
  "manage_agent_schedule.ts",
  "manage_behavior_preference.ts",
  "manage_family_invitation.ts",
  "manage_google_workspace_connection.ts",
  "manage_memory.ts",
  "manage_reminder.ts",
  "manage_telegram_group.ts",
  "notification_settings.ts",
  "remember.ts",
  "search_memories.ts",
  "send_workspace_file.ts",
  "start_new_context.ts",
] as const;

const EXPECTED_DISCOVERED_TOOL_FILES = ["capabilities.ts"] as const;

const EXPECTED_SKILL_DIRECTORIES = [
  "agent-browser",
  "behavior-preferences",
  "docx",
  "find-docs",
  "gws-calendar",
  "gws-calendar-agenda",
  "gws-calendar-insert",
  "gws-docs",
  "gws-docs-write",
  "gws-drive",
  "gws-drive-upload",
  "gws-gmail",
  "gws-gmail-forward",
  "gws-gmail-read",
  "gws-gmail-reply",
  "gws-gmail-reply-all",
  "gws-gmail-send",
  "gws-gmail-triage",
  "gws-gmail-watch",
  "gws-people",
  "gws-shared",
  "gws-sheets",
  "gws-sheets-append",
  "gws-sheets-read",
  "pdf",
  "pohuy",
  "t-invest",
  "xlsx",
] as const;

describe("agent capability surface", () => {
  it("discovers only the dynamic capability resolver as an authored tool", async () => {
    const entries = await readdir(`${AGENT_ROOT}/tools`, { withFileTypes: true });
    const toolFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    // A static descriptor would be visible in every mode, so no implementation may live here.
    expect(toolFiles).toEqual([...EXPECTED_DISCOVERED_TOOL_FILES]);
  });

  it("keeps every application tool implementation outside Eve discovery", async () => {
    const entries = await readdir(`${AGENT_ROOT}/lib/tools`, { withFileTypes: true });
    const toolModules = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();

    expect(toolModules).toEqual([...EXPECTED_TOOL_MODULES]);
  });

  it("keeps skills as native Eve packages only", async () => {
    const entries = await readdir(`${AGENT_ROOT}/skills`, { withFileTypes: true });
    const skillDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillDirectories).toEqual([...EXPECTED_SKILL_DIRECTORIES]);
    const skillFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .sort();
    expect(skillFiles).toEqual([]);
  });

  it("advertises the opt-in profanity skill as explicit-request only", async () => {
    const skill = await readFile(`${AGENT_ROOT}/skills/pohuy/SKILL.md`, "utf8");
    const description = /^---\n([\s\S]*?)\n---/u.exec(skill)?.[1] ?? "";

    // The description sits in every system prompt, so it must not self-activate on a user simply
    // swearing or being annoyed: only an explicit request may load this skill.
    expect(description).toContain("только по явной просьбе пользователя");
    expect(description).toContain("Не загружай, если пользователь просто раздражён");
    expect(description).not.toContain("та мне похуй");
    expect(description).not.toContain("заебал");

    // The activation step reads sibling references, so they must ship with the package.
    const references = await readdir(`${AGENT_ROOT}/skills/pohuy/references`);
    expect(references.sort()).toEqual(["ontologia.md", "sceny.md", "slovar.md"]);

    // The vendored copy must not try to reach the upstream repository from the sandbox.
    expect(skill).not.toContain("raw.githubusercontent.com");
  });

  it("requires every native skill package to declare SKILL.md", async () => {
    await Promise.all(
      EXPECTED_SKILL_DIRECTORIES.map(async (skillName) => {
        const files = await readdir(`${AGENT_ROOT}/skills/${skillName}`);

        expect(files).toContain("SKILL.md");
      }),
    );
  });
});
