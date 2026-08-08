/**
 * Mode-scoped executable tool surface.
 *
 * Exports:
 * - `ModeToolSurfaceInput`: verified facts a tool surface may be built from.
 * - `TRUSTED_MODE_TOOL_NAMES`, `PRIVATE_ONLY_TOOL_NAMES`, `FAMILY_ONLY_TOOL_NAMES`: the matrix.
 * - `buildModeToolSurface`: the exact tool map for one verified turn.
 *
 * Key constructs:
 * - Application tools are emitted per mode instead of authored statically, so a tool that cannot
 *   work in the current trust zone has no descriptor at all rather than a denial stub.
 * - External groups additionally deny the framework built-ins Eve always registers, and re-check
 *   every granted capability at execution time against the live database policy.
 */
import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { externalGroupLoadSkillTool } from "../group-skills/group-load-skill-tool.js";
import exportMemory from "../tools/export_memory.js";
import getMemorySource from "../tools/get_memory_source.js";
import getCurrentTime from "../tools/get_current_time.js";
import importTelegramAttachment from "../tools/import_telegram_attachment.js";
import inspectWorkspaceImage from "../tools/inspect_workspace_image.js";
import listAgentSchedules from "../tools/list_agent_schedules.js";
import listGroupHistory from "../tools/list_group_history.js";
import listMemories from "../tools/list_memories.js";
import listMemoryThreads from "../tools/list_memory_threads.js";
import listPendingFamilyInvitations from "../tools/list_pending_family_invitations.js";
import listProactiveDeliveries from "../tools/list_proactive_deliveries.js";
import listReminders from "../tools/list_reminders.js";
import listTelegramAttachments from "../tools/list_telegram_attachments.js";
import manageAgentSchedule from "../tools/manage_agent_schedule.js";
import manageBehaviorPreference from "../tools/manage_behavior_preference.js";
import manageFamilyInvitation from "../tools/manage_family_invitation.js";
import manageGoogleWorkspaceConnection from "../tools/manage_google_workspace_connection.js";
import manageMemory from "../tools/manage_memory.js";
import manageMemoryApproval from "../tools/manage_memory_approval.js";
import manageMemoryConflict from "../tools/manage_memory_conflict.js";
import manageMemoryThread from "../tools/manage_memory_thread.js";
import manageProfileProjection from "../tools/manage_profile_projection.js";
import manageReminder from "../tools/manage_reminder.js";
import manageTelegramGroup from "../tools/manage_telegram_group.js";
import notificationSettings from "../tools/notification_settings.js";
import remember from "../tools/remember.js";
import readProfileView from "../tools/read_profile_view.js";
import readMemoryThread from "../tools/read_memory_thread.js";
import searchMemories from "../tools/search_memories.js";
import searchMemoryThreads from "../tools/search_memory_threads.js";
import sendWorkspaceFile from "../tools/send_workspace_file.js";
import startNewContext from "../tools/start_new_context.js";
import { removeGroupFileTool } from "../workspaces/remove-group-file-tool.js";
import { controlledWebFetchTool } from "./controlled-web-fetch.js";
import { resolveExternalGroupToolPolicy } from "./external-group-policy.js";
import {
  FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
  isExternalGroupToolName,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ToolMap = Readonly<Record<string, AnyToolDefinition>>;

export type ModeToolSurfaceInput =
  | { environment: "family" | "private" }
  | {
      capabilities: ReadonlySet<ExternalGroupToolName>;
      environment: "external";
      includeApplicationCore?: boolean;
    };

const DENIED_TOOL_INPUT = z.record(z.string(), z.unknown());

/** Tools whose authorization boundary accepts both a private chat and a closed family group. */
export const TRUSTED_MODE_TOOLS: ToolMap = {
  get_current_time: getCurrentTime as unknown as AnyToolDefinition,
  inspect_workspace_image: inspectWorkspaceImage as unknown as AnyToolDefinition,
  list_agent_schedules: listAgentSchedules as unknown as AnyToolDefinition,
  list_memories: listMemories as unknown as AnyToolDefinition,
  list_memory_threads: listMemoryThreads as unknown as AnyToolDefinition,
  list_proactive_deliveries: listProactiveDeliveries as unknown as AnyToolDefinition,
  list_reminders: listReminders as unknown as AnyToolDefinition,
  manage_agent_schedule: manageAgentSchedule as unknown as AnyToolDefinition,
  manage_behavior_preference: manageBehaviorPreference as unknown as AnyToolDefinition,
  manage_google_workspace_connection:
    manageGoogleWorkspaceConnection as unknown as AnyToolDefinition,
  manage_memory: manageMemory as unknown as AnyToolDefinition,
  manage_memory_approval: manageMemoryApproval as unknown as AnyToolDefinition,
  manage_memory_conflict: manageMemoryConflict as unknown as AnyToolDefinition,
  manage_memory_thread: manageMemoryThread as unknown as AnyToolDefinition,
  manage_reminder: manageReminder as unknown as AnyToolDefinition,
  remember: remember as unknown as AnyToolDefinition,
  read_profile_view: readProfileView as unknown as AnyToolDefinition,
  read_memory_thread: readMemoryThread as unknown as AnyToolDefinition,
  search_memories: searchMemories as unknown as AnyToolDefinition,
  search_memory_threads: searchMemoryThreads as unknown as AnyToolDefinition,
  send_workspace_file: sendWorkspaceFile as unknown as AnyToolDefinition,
  start_new_context: startNewContext as unknown as AnyToolDefinition,
};

/** Owner administration and personal-only surfaces that require the owner's private chat. */
export const PRIVATE_ONLY_TOOLS: ToolMap = {
  export_memory: exportMemory as unknown as AnyToolDefinition,
  get_memory_source: getMemorySource as unknown as AnyToolDefinition,
  list_pending_family_invitations: listPendingFamilyInvitations as unknown as AnyToolDefinition,
  manage_family_invitation: manageFamilyInvitation as unknown as AnyToolDefinition,
  manage_telegram_group: manageTelegramGroup as unknown as AnyToolDefinition,
  manage_profile_projection: manageProfileProjection as unknown as AnyToolDefinition,
  notification_settings: notificationSettings as unknown as AnyToolDefinition,
};

/** Lazy group attachments and stored group history exist only inside a registered family group. */
export const FAMILY_ONLY_TOOLS: ToolMap = {
  import_telegram_attachment: importTelegramAttachment as unknown as AnyToolDefinition,
  list_group_history: listGroupHistory as unknown as AnyToolDefinition,
  list_telegram_attachments: listTelegramAttachments as unknown as AnyToolDefinition,
};

export const TRUSTED_MODE_TOOL_NAMES = Object.keys(TRUSTED_MODE_TOOLS).sort();
export const PRIVATE_ONLY_TOOL_NAMES = Object.keys(PRIVATE_ONLY_TOOLS).sort();
export const FAMILY_ONLY_TOOL_NAMES = Object.keys(FAMILY_ONLY_TOOLS).sort();

type DirectExternalToolName = Exclude<
  ExternalGroupToolName,
  `manage_memory.${string}` | `manage_memory_thread.${string}` | "web_search"
>;

const EXTERNAL_DIRECT_TOOLS: Readonly<Record<DirectExternalToolName, AnyToolDefinition>> = {
  inspect_workspace_image: inspectWorkspaceImage as unknown as AnyToolDefinition,
  list_group_history: listGroupHistory as unknown as AnyToolDefinition,
  list_memories: listMemories as unknown as AnyToolDefinition,
  list_memory_threads: listMemoryThreads as unknown as AnyToolDefinition,
  manage_memory_conflict: manageMemoryConflict as unknown as AnyToolDefinition,
  remember: remember as unknown as AnyToolDefinition,
  read_memory_thread: readMemoryThread as unknown as AnyToolDefinition,
  remove_group_file: removeGroupFileTool as unknown as AnyToolDefinition,
  search_memories: searchMemories as unknown as AnyToolDefinition,
  search_memory_threads: searchMemoryThreads as unknown as AnyToolDefinition,
  send_workspace_file: sendWorkspaceFile as unknown as AnyToolDefinition,
  web_fetch: controlledWebFetchTool as unknown as AnyToolDefinition,
};

function groupToolForbidden(): AppError {
  return new AppError(
    "AGENT_GROUP_TOOL_FORBIDDEN",
    "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
  );
}

function assertExternalGroupCapabilityAllowed(
  ctx: ToolContext,
  capability: ExternalGroupToolName,
): void {
  const policy = resolveExternalGroupToolPolicy(ctx.session.auth);
  if (!policy.restricted || !policy.allowed.has(capability)) throw groupToolForbidden();
}

function deniedTool(toolName: string): AnyToolDefinition {
  return defineTool({
    description: `Инструмент ${toolName} недоступен в текущей внешней группе.`,
    inputSchema: DENIED_TOOL_INPUT,
    async execute() {
      throw groupToolForbidden();
    },
  }) as unknown as AnyToolDefinition;
}

function allowedDirectTool(
  capability: DirectExternalToolName,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      assertExternalGroupCapabilityAllowed(ctx, capability);
      return await definition.execute(input, ctx);
    },
  });
}

function allowedMemoryTool(): AnyToolDefinition {
  const definition = manageMemory as unknown as AnyToolDefinition;
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      const action = (input as { action?: unknown }).action;
      if (action !== "edit" && action !== "delete" && action !== "undo") {
        throw new AppError(
          "AGENT_GROUP_TOOL_INPUT_INVALID",
          "Не удалось определить операцию с памятью. Повторите запрос",
        );
      }
      assertExternalGroupCapabilityAllowed(ctx, `manage_memory.${action}`);
      return await definition.execute(input, ctx);
    },
  });
}

function allowedMemoryThreadTool(): AnyToolDefinition {
  const definition = manageMemoryThread as unknown as AnyToolDefinition;
  return defineTool({
    ...definition,
    async execute(input, ctx) {
      const action = (input as { action?: unknown }).action;
      if (action !== "complete" && action !== "reactivate") {
        throw new AppError(
          "AGENT_GROUP_TOOL_INPUT_INVALID",
          "Не удалось определить операцию с нитью памяти. Повторите запрос",
        );
      }
      assertExternalGroupCapabilityAllowed(ctx, `manage_memory_thread.${action}`);
      return await definition.execute(input, ctx);
    },
  });
}

function buildExternalToolSurface(
  allowed: ReadonlySet<ExternalGroupToolName>,
  includeApplicationCore: boolean,
): ToolMap {
  const surface: Record<string, AnyToolDefinition> = {
    // Eve decides whether to advertise this built-in from the turn's dynamic skill set. The wrapper
    // independently enforces the live database grant at execution time.
    load_skill: externalGroupLoadSkillTool,
  };
  if (includeApplicationCore) {
    surface.manage_memory_approval = manageMemoryApproval as unknown as AnyToolDefinition;
    surface.read_profile_view = readProfileView as unknown as AnyToolDefinition;
  }

  // Granted application capabilities are re-checked at execution against the live policy.
  for (const capability of allowed) {
    if (capability === "web_search") continue;
    if (capability.startsWith("manage_memory.")) continue;
    if (capability.startsWith("manage_memory_thread.")) continue;
    if (!isExternalGroupToolName(capability)) continue;
    const definition = EXTERNAL_DIRECT_TOOLS[capability as DirectExternalToolName];
    if (definition === undefined) continue;
    surface[capability] = allowedDirectTool(capability as DirectExternalToolName, definition);
  }
  if ([...allowed].some((capability) => capability.startsWith("manage_memory."))) {
    surface.manage_memory = allowedMemoryTool();
  }
  if ([...allowed].some((capability) => capability.startsWith("manage_memory_thread."))) {
    surface.manage_memory_thread = allowedMemoryThreadTool();
  }

  // Eve always registers its own built-ins, and 0.22.5 cannot hide a framework descriptor, so the
  // ones an external group must never reach stay overridden with an explicit denial.
  for (const toolName of FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS) {
    if (toolName === "web_search" || toolName === "web_fetch") {
      if (!allowed.has(toolName)) surface[toolName] = deniedTool(toolName);
      continue;
    }
    surface[toolName] = deniedTool(toolName);
  }
  return surface;
}

function allowlistKey(allowed: ReadonlySet<ExternalGroupToolName>): string {
  return [...allowed].sort().join(" ");
}

const TRUSTED_SURFACES: Readonly<Record<"family" | "private", ToolMap>> = {
  family: { ...TRUSTED_MODE_TOOLS, ...FAMILY_ONLY_TOOLS },
  private: { ...TRUSTED_MODE_TOOLS, ...PRIVATE_ONLY_TOOLS },
};

const EXTERNAL_SURFACES = new Map<string, ToolMap>();

export function buildModeToolSurface(input: ModeToolSurfaceInput): ToolMap {
  if (input.environment !== "external") return TRUSTED_SURFACES[input.environment];

  // A malformed allowlist value means the trusted snapshot is corrupt, so deny every capability.
  const allowed = [...input.capabilities].some((name) => !isExternalGroupToolName(name))
    ? new Set<ExternalGroupToolName>()
    : input.capabilities;
  const includeApplicationCore = input.includeApplicationCore !== false;
  const key = `${includeApplicationCore ? "core" : "failed"}:${allowlistKey(allowed)}`;
  const cached = EXTERNAL_SURFACES.get(key);
  if (cached) return cached;
  const surface = buildExternalToolSurface(allowed, includeApplicationCore);
  EXTERNAL_SURFACES.set(key, surface);
  return surface;
}
