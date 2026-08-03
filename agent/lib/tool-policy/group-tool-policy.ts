/**
 * External Telegram group execution policy.
 *
 * Exports:
 * - `resolveExternalGroupToolPolicy`: reads a fail-closed policy from verified Eve auth.
 * - `resolveExternalGroupPolicyIdentity`: reads the verified family/group policy key.
 * - `createExternalGroupToolOverrides`: creates step-scoped action-aware tool overrides.
 */
import type { SessionAuth } from "eve/context";
import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { z } from "zod";

import inspectWorkspaceImage from "../../tools/inspect_workspace_image.js";
import listMemories from "../../tools/list_memories.js";
import listGroupHistory from "../../tools/list_group_history.js";
import manageMemory from "../../tools/manage_memory.js";
import remember from "../../tools/remember.js";
import searchMemories from "../../tools/search_memories.js";
import sendWorkspaceFile from "../../tools/send_workspace_file.js";
import { AppError } from "../app-error.js";
import { removeGroupFileTool } from "../workspaces/remove-group-file-tool.js";
import { controlledWebFetchTool } from "./controlled-web-fetch.js";
import {
  CONTROLLED_TOOL_NAMES,
  isExternalGroupToolName,
  parseExternalGroupToolAllowlist,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

interface RestrictedGroupToolPolicy {
  allowed: ReadonlySet<ExternalGroupToolName>;
  restricted: true;
}

type GroupToolPolicy = RestrictedGroupToolPolicy | { restricted: false };
type AnyToolDefinition = ToolDefinition<any, any>;
type DirectExternalToolName = Exclude<
  ExternalGroupToolName,
  `manage_memory.${string}` | "web_search"
>;

const DIRECT_TOOL_DEFINITIONS: Readonly<Record<DirectExternalToolName, AnyToolDefinition>> = {
  inspect_workspace_image: inspectWorkspaceImage as unknown as AnyToolDefinition,
  list_group_history: listGroupHistory as unknown as AnyToolDefinition,
  list_memories: listMemories as unknown as AnyToolDefinition,
  remember: remember as unknown as AnyToolDefinition,
  remove_group_file: removeGroupFileTool as unknown as AnyToolDefinition,
  search_memories: searchMemories as unknown as AnyToolDefinition,
  send_workspace_file: sendWorkspaceFile as unknown as AnyToolDefinition,
  web_fetch: controlledWebFetchTool as unknown as AnyToolDefinition,
};

const DENIED_TOOL_INPUT = z.record(z.string(), z.unknown());

function isExternalPrincipal(principal: SessionAuth["current"]): boolean {
  const groupType = principal?.attributes.groupType;
  return groupType === "external";
}

function externalPolicyCaller(auth: SessionAuth): SessionAuth["current"] {
  const currentExternal = isExternalPrincipal(auth.current);
  const initiatorExternal = isExternalPrincipal(auth.initiator);
  if (!currentExternal && !initiatorExternal) return null;

  // An external initiator permanently taints a resumed session. A present current principal may
  // replace its policy only when it proves the same external trust zone; every conflict denies all.
  if (initiatorExternal && auth.current) {
    const sameGroup = auth.current.attributes.groupId === auth.initiator?.attributes.groupId;
    return currentExternal && sameGroup ? auth.current : null;
  }
  if (!auth.current && initiatorExternal) return auth.initiator;
  return auth.current;
}

export function resolveExternalGroupPolicyIdentity(auth: SessionAuth): {
  familyId: string;
  groupId: string;
} | null {
  const caller = externalPolicyCaller(auth);
  const familyId = caller?.attributes.familyId;
  const groupId = caller?.attributes.groupId;
  return typeof familyId === "string" && typeof groupId === "string"
    ? { familyId, groupId }
    : null;
}

export function resolveExternalGroupToolPolicy(auth: SessionAuth): GroupToolPolicy {
  const currentExternal = isExternalPrincipal(auth.current);
  const initiatorExternal = isExternalPrincipal(auth.initiator);
  if (!currentExternal && !initiatorExternal) return { restricted: false };

  const caller = externalPolicyCaller(auth);
  const allowed = caller ? parseExternalGroupToolAllowlist(caller.attributes.toolAllowlist) : null;

  // Corrupt or incomplete trusted policy must deny everything rather than expose static tools.
  return {
    allowed: allowed ?? new Set(),
    restricted: true,
  };
}

function assertExternalGroupCapabilityAllowed(
  ctx: ToolContext,
  capability: ExternalGroupToolName,
): void {
  const policy = resolveExternalGroupToolPolicy(ctx.session.auth);
  if (!policy.restricted || !policy.allowed.has(capability)) {
    throw new AppError(
      "AGENT_GROUP_TOOL_FORBIDDEN",
      "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
    );
  }
}

function deniedTool(toolName: string): AnyToolDefinition {
  return defineTool({
    description: `Инструмент ${toolName} недоступен в текущей внешней группе.`,
    inputSchema: DENIED_TOOL_INPUT,
    async execute() {
      throw new AppError(
        "AGENT_GROUP_TOOL_FORBIDDEN",
        "Этот инструмент не разрешён в текущей внешней группе. Обратитесь к владельцу агента",
      );
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
  return defineTool({
    ...(manageMemory as unknown as AnyToolDefinition),
    async execute(input, ctx) {
      const action = (input as { action?: unknown }).action;
      if (action !== "edit" && action !== "delete" && action !== "undo") {
        throw new AppError(
          "AGENT_GROUP_TOOL_INPUT_INVALID",
          "Не удалось определить операцию с памятью. Повторите запрос",
        );
      }
      assertExternalGroupCapabilityAllowed(ctx, `manage_memory.${action}`);
      return await (manageMemory as unknown as AnyToolDefinition).execute(input, ctx);
    },
  });
}

function buildExternalGroupToolOverrides(
  allowed: ReadonlySet<ExternalGroupToolName>,
): Readonly<Record<string, AnyToolDefinition>> {
  // Every static app, network, shell, and orchestration capability is overridden fail-closed.
  const overrides: Record<string, AnyToolDefinition> = {};
  for (const toolName of CONTROLLED_TOOL_NAMES) {
    // An allowed provider-native search must remain absent from this dynamic override map.
    if (toolName === "web_search") {
      if (!allowed.has("web_search")) overrides.web_search = deniedTool(toolName);
      continue;
    }
    if (toolName === "manage_memory") {
      const hasMemoryCapability = [...allowed].some((name) => name.startsWith("manage_memory."));
      overrides[toolName] = hasMemoryCapability ? allowedMemoryTool() : deniedTool(toolName);
      continue;
    }
    if (isExternalGroupToolName(toolName)) {
      overrides[toolName] = allowed.has(toolName)
        ? allowedDirectTool(toolName, DIRECT_TOOL_DEFINITIONS[toolName])
        : deniedTool(toolName);
      continue;
    }
    overrides[toolName] = deniedTool(toolName);
  }

  // This capability has no global static descriptor because trusted sandboxes already use Bash.
  if (allowed.has("remove_group_file")) {
    overrides.remove_group_file = allowedDirectTool(
      "remove_group_file",
      DIRECT_TOOL_DEFINITIONS.remove_group_file,
    );
  }
  return overrides;
}

function allowlistKey(allowed: ReadonlySet<ExternalGroupToolName>): string {
  return [...allowed].sort().join("\u0000");
}

const EXTERNAL_GROUP_OVERRIDE_SETS = new Map<string, Readonly<Record<string, AnyToolDefinition>>>();
EXTERNAL_GROUP_OVERRIDE_SETS.set("", buildExternalGroupToolOverrides(new Set()));

export function createExternalGroupToolOverrides(
  allowed: ReadonlySet<ExternalGroupToolName>,
): Readonly<Record<string, AnyToolDefinition>> {
  if ([...allowed].some((name) => !isExternalGroupToolName(name))) {
    return EXTERNAL_GROUP_OVERRIDE_SETS.get("")!;
  }
  const key = allowlistKey(allowed);
  const cached = EXTERNAL_GROUP_OVERRIDE_SETS.get(key);
  if (cached) return cached;
  const overrides = buildExternalGroupToolOverrides(allowed);
  EXTERNAL_GROUP_OVERRIDE_SETS.set(key, overrides);
  return overrides;
}
