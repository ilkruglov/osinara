/**
 * Eve dynamic tool surface for the current verified conversation mode.
 *
 * Export:
 * - Turn-scoped tool map resolved from verified auth and the live external-group policy.
 *
 * Key constructs:
 * - One resolver owns the whole application surface: two resolvers emitting the same tool name is
 *   an ambiguity Eve rejects, and a single map keeps mode and capability policy consistent.
 * - Tool and skill visibility share one turn boundary; execution still rechecks live revocation.
 * - Each independent policy lookup fails closed for its own application capability class.
 */
import { defineDynamic } from "eve/tools";

import { resolveConversationEnvironment } from "../lib/conversation-environment.js";
import { selectGroupSafeSkillDefinitions } from "../lib/group-skills/group-skill-definitions.js";
import { loadCurrentExternalGroupCapabilities } from "../lib/tool-policy/external-group-live-policy.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupSkillPolicy,
  resolveExternalGroupToolPolicy,
} from "../lib/tool-policy/external-group-policy.js";
import type { ExternalGroupToolName } from "../lib/tool-policy/group-tool-catalog.js";
import {
  buildModeToolSurface,
  buildSubagentToolSurface,
} from "../lib/tool-policy/mode-tool-surface.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const auth = ctx.session.auth;
      const buildSurface = ctx.channel.kind === "subagent"
        ? buildSubagentToolSurface
        : buildModeToolSurface;
      let environment: ReturnType<typeof resolveConversationEnvironment>;
      try {
        environment = resolveConversationEnvironment(auth);
      } catch (error) {
        // Without a proven trust zone there is no surface to expose. The instructions resolver
        // separately tells the model that this turn cannot use tools at all.
        console.error(JSON.stringify({
          code: "AGENT_TOOL_SURFACE_ENVIRONMENT_INVALID",
          error: error instanceof Error ? error.message : String(error),
        }));
        return buildSurface({
          capabilities: new Set(),
          environment: "external",
          includeApplicationCore: false,
          skills: {},
        });
      }
      if (environment !== "external") return buildSurface({ environment });

      const policy = resolveExternalGroupToolPolicy(auth);
      const identity = resolveExternalGroupPolicyIdentity(auth);
      if (!policy.restricted || !identity) {
        return buildSurface({
          capabilities: new Set(),
          environment: "external",
          includeApplicationCore: false,
          skills: {},
        });
      }

      // Intersection prevents a stale verified session from gaining capabilities outside its auth
      // snapshot. Execution wrappers independently enforce revocation after this turn boundary.
      let current: ReadonlySet<ExternalGroupToolName> = new Set();
      let includeApplicationCore = true;
      try {
        current = await loadCurrentExternalGroupCapabilities(identity);
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_GROUP_TOOL_POLICY_LOOKUP_FAILED",
          error: error instanceof Error ? error.message : String(error),
          groupId: identity.groupId,
        }));
        // R0-R7 core tools also rely on a current external registration, while independently
        // live-checked skills may still remain available for this turn.
        includeApplicationCore = false;
      }

      // Skill descriptors use the same verified turn snapshot as Eve's dynamic skill resolver.
      // Live execution still denies a skill that the owner revokes while this turn is running.
      const skills = selectGroupSafeSkillDefinitions(resolveExternalGroupSkillPolicy(auth));
      return buildSurface({
        capabilities: new Set([...policy.allowed].filter((name) => current.has(name))),
        environment: "external",
        includeApplicationCore,
        skills,
      });
    },
  },
});
