/**
 * Eve dynamic tool surface for the current verified conversation mode.
 *
 * Export:
 * - Step-scoped tool map resolved from verified auth and the live external-group policy.
 *
 * Key constructs:
 * - One resolver owns the whole application surface: two resolvers emitting the same tool name is
 *   an ambiguity Eve rejects, and a single map keeps mode and capability policy consistent.
 * - `step.started` re-resolves before every model call, so an owner's revocation applies mid-turn.
 * - Any failure yields no application tools at all, which is the fail-closed direction.
 */
import { defineDynamic } from "eve/tools";

import { resolveConversationEnvironment } from "../lib/conversation-environment.js";
import { loadCurrentExternalGroupCapabilities } from "../lib/tool-policy/external-group-live-policy.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../lib/tool-policy/external-group-policy.js";
import type { ExternalGroupToolName } from "../lib/tool-policy/group-tool-catalog.js";
import { buildModeToolSurface } from "../lib/tool-policy/mode-tool-surface.js";

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
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
        return buildModeToolSurface({
          capabilities: new Set(),
          environment: "external",
          includeApplicationCore: false,
        });
      }
      if (environment !== "external") return buildModeToolSurface({ environment });

      const policy = resolveExternalGroupToolPolicy(auth);
      const identity = resolveExternalGroupPolicyIdentity(auth);
      if (!policy.restricted || !identity) {
        return buildModeToolSurface({
          capabilities: new Set(),
          environment: "external",
          includeApplicationCore: false,
        });
      }

      // Revocation takes effect before every model call. Intersection prevents a stale session from
      // gaining capabilities that were granted only after its verified snapshot was established.
      let current: ReadonlySet<ExternalGroupToolName>;
      try {
        current = await loadCurrentExternalGroupCapabilities(identity);
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_GROUP_TOOL_POLICY_LOOKUP_FAILED",
          error: error instanceof Error ? error.message : String(error),
          groupId: identity.groupId,
        }));
        return buildModeToolSurface({
          capabilities: new Set(),
          environment: "external",
          includeApplicationCore: false,
        });
      }
      return buildModeToolSurface({
        capabilities: new Set([...policy.allowed].filter((name) => current.has(name))),
        environment: "external",
      });
    },
  },
});
