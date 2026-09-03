/**
 * Lifecycle-scoped Eve skill visibility resolvers.
 *
 * Exports:
 * - `resolveTrustedSessionSkills`: stable private/family packages materialized once per session.
 * - `resolveExternalTurnSkills`: external capability-coupled packages refreshed per turn.
 */
import type { SessionAuth } from "eve/context";
import type { SkillDefinition } from "eve/skills";

import { resolveConversationEnvironment } from "../conversation-environment.js";
import { GOOGLE_WORKSPACE_AVAILABLE } from "../google-workspace/google-workspace-availability.js";
import { IMAGE_GENERATION_AVAILABLE } from "../image-generation/image-generation-availability.js";
import {
  IMAGE_GENERATION_SKILL_DEFINITION,
  IMAGE_GENERATION_SKILL_NAME,
} from "../image-generation/image-generation-skill.js";
import { resolveExternalGroupToolPolicy } from "../tool-policy/external-group-policy.js";
import { TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS } from "./trusted-google-workspace-skills.js";

interface ConversationSkillResolverOptions {
  scheduledRun?: boolean;
  subagent?: boolean;
}

function imageGenerationSkill(
  options: ConversationSkillResolverOptions,
): Record<string, SkillDefinition> {
  return IMAGE_GENERATION_AVAILABLE &&
      options.scheduledRun !== true && options.subagent !== true
    ? { [IMAGE_GENERATION_SKILL_NAME]: IMAGE_GENERATION_SKILL_DEFINITION }
    : {};
}

export function resolveTrustedSessionSkills(
  auth: SessionAuth,
  options: ConversationSkillResolverOptions = {},
): Record<string, SkillDefinition> {
  const environment = resolveConversationEnvironment(auth);
  if (environment === "external") return {};
  return {
    ...imageGenerationSkill(options),
    // Nineteen packages are uploaded into the sandbox per session; skip them when nobody can
    // connect a Google account anyway.
    ...(GOOGLE_WORKSPACE_AVAILABLE ? TRUSTED_GOOGLE_WORKSPACE_SKILL_DEFINITIONS : {}),
  };
}

export function resolveExternalTurnSkills(
  auth: SessionAuth,
  options: ConversationSkillResolverOptions = {},
): Record<string, SkillDefinition> {
  if (resolveConversationEnvironment(auth) !== "external") return {};
  const tools = resolveExternalGroupToolPolicy(auth);
  return tools.restricted && tools.allowed.has("generate_image")
    ? imageGenerationSkill(options)
    : {};
}
