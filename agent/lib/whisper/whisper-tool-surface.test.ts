/**
 * The tool surface of a whisper turn.
 *
 * Constructs covered:
 * - Only reading tools survive: memory and history lookups, web reading, skills, files read-only.
 * - Everything that writes memory or shows something in the chat (images, files, cards, buttons)
 *   has no descriptor at all.
 * - Eve built-ins that would act or ask in the chat are overridden with a refusal.
 */
import { describe, expect, it } from "vitest";

import { WHISPER_DENIED_FRAMEWORK_TOOLS, WHISPER_TOOL_NAMES, whisperToolSurface } from "./whisper-tool-surface.js";

const tool = { description: "x", execute: async () => "ok", inputSchema: {} } as never;

describe("whisperToolSurface", () => {
  it("keeps reading tools and drops every writing or chat-visible one", () => {
    const surface = whisperToolSurface({
      generate_image: tool,
      get_current_time: tool,
      list_group_history: tool,
      manage_behavior_preference: tool,
      manage_memory: tool,
      manage_reminder: tool,
      read_file: tool,
      remember: tool,
      search_memories: tool,
      send_widget: tool,
      send_workspace_file: tool,
      send_workspace_image: tool,
      web_search: tool,
      write_file: tool,
    });

    expect(Object.keys(surface).filter((name) => !WHISPER_DENIED_FRAMEWORK_TOOLS.includes(name as never)).sort()).toEqual([
      "get_current_time", "list_group_history", "read_file", "search_memories", "web_search",
    ]);
  });

  it("overrides the built-ins that would act or ask in the chat with a refusal", async () => {
    const surface = whisperToolSurface({ write_file: tool });

    for (const name of ["agent", "ask_question", "bash", "todo", "write_file"]) {
      expect(surface[name], name).toBeDefined();
      expect(surface[name]).not.toBe(tool);
      await expect(surface[name]!.execute({}, {} as never)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_WHISPER_TOOL_FORBIDDEN" });
    }
  });

  it("never lists a writing tool among the allowed names", () => {
    for (const name of WHISPER_TOOL_NAMES) {
      expect(name).not.toMatch(/^(remember|manage_|send_|generate_|write_file|bash|browser_)/u);
    }
  });
});
