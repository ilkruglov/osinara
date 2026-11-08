/**
 * The tool surface of a whisper turn: reading only.
 *
 * Exports:
 * - `WHISPER_TOOL_NAMES`: tools a whisper keeps from its group's surface.
 * - `WHISPER_DENIED_FRAMEWORK_TOOLS`: Eve built-ins overridden with a refusal.
 * - `whisperToolSurface`: the group's surface narrowed to a whisper.
 *
 * Key constructs:
 * - A whisper is an answer only its author sees. Anything that shows up in the chat (an image, a
 *   file, a card, a confirmation button, a question) would reveal it, and a memory write or a chat
 *   instruction would carry it into the group's future answers. So a whisper keeps the reading
 *   tools of its group, whatever the group itself may do.
 * - Eve 0.40 registers its built-ins in every session and cannot hide them, so the ones that act
 *   or ask (`bash`, `write_file`, `todo`, `ask_question`, the `agent` delegation) are overridden
 *   by a same-name refusal, as in an external group. `read_file`, `glob` and `grep` stay.
 */
import { defineTool, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ToolMap = Readonly<Record<string, AnyToolDefinition>>;

export const WHISPER_TOOL_NAMES = [
  "get_current_time",
  "get_memory_source",
  "glob",
  "grep",
  "list_group_history",
  "list_memories",
  "list_memory_threads",
  "load_skill",
  "read_file",
  "read_memory_thread",
  "read_profile_view",
  "search_memories",
  "search_memory_threads",
  "web_fetch",
  "web_search",
] as const;

export const WHISPER_DENIED_FRAMEWORK_TOOLS = [
  "agent",
  "ask_question",
  "bash",
  "todo",
  "write_file",
] as const;

const ALLOWED = new Set<string>(WHISPER_TOOL_NAMES);

function deniedInWhisper(toolName: string): AnyToolDefinition {
  return defineTool({
    description: `Инструмент ${toolName} недоступен в шёпоте: здесь можно только читать.`,
    inputSchema: z.record(z.string(), z.unknown()),
    async execute() {
      throw new AppError(
        "AGENT_TELEGRAM_WHISPER_TOOL_FORBIDDEN",
        "В шёпоте доступны только чтение и поиск. Для действий напишите Мии в группе или в личном чате",
      );
    },
  }) as unknown as AnyToolDefinition;
}

export function whisperToolSurface(surface: ToolMap): ToolMap {
  const narrowed: Record<string, AnyToolDefinition> = Object.fromEntries(
    Object.entries(surface).filter(([name]) => ALLOWED.has(name)),
  );
  for (const name of WHISPER_DENIED_FRAMEWORK_TOOLS) narrowed[name] = deniedInWhisper(name);
  return narrowed;
}
