/**
 * Eve dynamic external-group tool policy.
 *
 * Export:
 * - Step-scoped fail-closed overrides from verified auth and current PostgreSQL policy.
 */
import { defineDynamic } from "eve/tools";

import {
  createExternalGroupToolOverrides,
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../lib/tool-policy/group-tool-policy.js";
import { loadCurrentExternalGroupCapabilities } from "../lib/tool-policy/external-group-live-policy.js";

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const auth = ctx.session.auth;
      const policy = resolveExternalGroupToolPolicy(auth);
      if (!policy.restricted) return null;
      const identity = resolveExternalGroupPolicyIdentity(auth);
      if (!identity) return createExternalGroupToolOverrides(new Set());

      // Revocation takes effect before every model call. Intersection prevents a stale session from
      // gaining capabilities that were granted only after its verified snapshot was established.
      let current: Awaited<ReturnType<typeof loadCurrentExternalGroupCapabilities>>;
      try {
        current = await loadCurrentExternalGroupCapabilities(identity);
      } catch (error) {
        // Eve skips a failed dynamic resolver, which would expose static tools. This boundary must
        // therefore convert an unavailable required policy into an explicit deny-all tool surface.
        console.error(JSON.stringify({
          code: "AGENT_GROUP_TOOL_POLICY_LOOKUP_FAILED",
          error: error instanceof Error ? error.message : String(error),
          groupId: identity.groupId,
        }));
        return createExternalGroupToolOverrides(new Set());
      }
      const effective = new Set([...policy.allowed].filter((capability) => current.has(capability)));
      return createExternalGroupToolOverrides(effective);
    },
  },
});
