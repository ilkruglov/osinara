/**
 * Turn-scoped external-group effective capability instructions.
 *
 * Export:
 * - Eve dynamic instructions generated from the verified external-group allowlist.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { externalGroupCapabilityInstructions } from "../lib/tool-policy/external-group-capability-instructions.js";
import { loadCurrentExternalGroupCapabilities } from "../lib/tool-policy/external-group-live-policy.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../lib/tool-policy/group-tool-policy.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      // Re-resolve each turn so an owner-approved allowlist change cannot leave stale guidance.
      const auth = ctx.session.auth;
      const policy = resolveExternalGroupToolPolicy(auth);
      if (!policy.restricted) return null;
      const identity = resolveExternalGroupPolicyIdentity(auth);
      const current = identity
        ? await loadCurrentExternalGroupCapabilities(identity)
        : new Set<never>();
      const effective = new Set([...policy.allowed].filter((capability) => current.has(capability)));
      return defineInstructions({
        markdown: externalGroupCapabilityInstructions(effective),
      });
    },
  },
});
