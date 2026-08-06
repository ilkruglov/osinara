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
} from "../lib/tool-policy/mode-tool-surface.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const auth = ctx.session.auth;
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
        return buildModeToolSurface({ capabilities: new Set(), environment: "external", skills: {} });
      }
      if (environment !== "external") return buildModeToolSurface({ environment });

      const policy = resolveExternalGroupToolPolicy(auth);
      const identity = resolveExternalGroupPolicyIdentity(auth);
      if (!policy.restricted || !identity) {
        return buildModeToolSurface({ capabilities: new Set(), environment: "external", skills: {} });
      }

      // Intersection prevents a stale verified session from gaining capabilities outside its auth
      // snapshot. Execution wrappers independently enforce revocation after this turn boundary.
      let current: ReadonlySet<ExternalGroupToolName> = new Set();
      try {
        current = await loadCurrentExternalGroupCapabilities(identity);
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_GROUP_TOOL_POLICY_LOOKUP_FAILED",
          error: error instanceof Error ? error.message : String(error),
          groupId: identity.groupId,
        }));
      }

      // Skill descriptors use the same verified turn snapshot as Eve's dynamic skill resolver.
      // Live execution still denies a skill that the owner revokes while this turn is running.
      const skills = selectGroupSafeSkillDefinitions(resolveExternalGroupSkillPolicy(auth));
      return buildModeToolSurface({
        capabilities: new Set([...policy.allowed].filter((name) => current.has(name))),
        environment: "external",
        skills,
      });
    },
  },
});
