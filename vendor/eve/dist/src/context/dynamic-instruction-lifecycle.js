import { createLogger } from "#internal/logging.js";
import {
  DynamicInstructionResolveMessagesKey,
  PendingDynamicInstructionUserMessagesKey,
  SessionDynamicInstructionsKey,
  TurnDynamicInstructionsKey,
} from "#context/keys.js";
import { toErrorMessage } from "#shared/errors.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import {
  ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
  isBrandedInstructionsEntry,
} from "#shared/dynamic-tool-definition.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
const log = createLogger(`dynamic-instructions`);
function lowerInstruction(e) {
  let t = normalizeInstructionsDefinition(
      e,
      `Expected dynamic instructions to match the public eve shape.`,
    ),
    n = t.content.trim();
  if (n.length !== 0)
    return t.role === `system`
      ? { role: `system`, message: { role: `system`, content: n } }
      : { role: `user`, message: { role: `user`, content: n } };
}
function durableKeyForEvent(e) {
  switch (e) {
    case `session.started`:
      return SessionDynamicInstructionsKey;
    case `turn.started`:
      return TurnDynamicInstructionsKey;
    default:
      return;
  }
}
function buildDynamicInstructionMessages(e) {
  let t = e.get(SessionDynamicInstructionsKey) ?? {},
    n = e.get(TurnDynamicInstructionsKey) ?? {};
  return [...Object.values(t).flat(), ...Object.values(n).flat()];
}
function prepareDynamicInstructionPreamble(e, r) {
  (e.setVirtualContext(DynamicInstructionResolveMessagesKey, [...r]),
    e.setVirtualContext(PendingDynamicInstructionUserMessagesKey, []));
}
function drainDynamicInstructionUserMessages(e) {
  let r = [...(e.get(PendingDynamicInstructionUserMessagesKey) ?? [])];
  return (
    e.delete(DynamicInstructionResolveMessagesKey),
    e.delete(PendingDynamicInstructionUserMessagesKey),
    r
  );
}
async function dispatchDynamicInstructionEvent(e) {
  let { ctx: r, resolvers: a, event: o, messages: s } = e;
  if (!ALLOWED_DYNAMIC_INSTRUCTION_EVENTS.has(o.type)) return;
  o.type === `turn.started` && r.set(TurnDynamicInstructionsKey, {});
  let c = a.filter((e) => e.eventNames.includes(o.type));
  if (c.length === 0) return;
  let l = durableKeyForEvent(o.type);
  if (l === void 0) return;
  let u = r.get(DynamicInstructionResolveMessagesKey) ?? s,
    d = r.get(PendingDynamicInstructionUserMessagesKey) ?? [],
    f = buildResolveContext(r, [...u, ...d]),
    p = await Promise.allSettled(
      c.map(async (e) => {
        let t = e.events[o.type];
        if (t === void 0) return null;
        let n = await t(o, f);
        if (n == null) return { resolver: e, instruction: void 0 };
        if (!isBrandedInstructionsEntry(n))
          return (
            log.error(
              `Dynamic instructions resolver "${e.slug}" returned an unbranded value — wrap with defineInstructions().`,
            ),
            null
          );
        try {
          return { resolver: e, instruction: lowerInstruction(n) };
        } catch (t) {
          return (
            log.error(
              `Dynamic instructions resolver "${e.slug}" returned an invalid value.`,
              { error: toErrorMessage(t) },
            ),
            null
          );
        }
      }),
    ),
    m = { ...r.get(l) };
  for (let e of p) {
    if (e.status === `rejected`) {
      log.error(`Dynamic instructions resolver (${o.type}) threw — skipping.`, {
        error: toErrorMessage(e.reason),
      });
      continue;
    }
    if (e.value === null) continue;
    let { resolver: t, instruction: i } = e.value;
    (delete m[t.slug],
      i?.role === `system`
        ? (m[t.slug] = [i.message])
        : i?.role === `user` &&
          r.setVirtualContext(PendingDynamicInstructionUserMessagesKey, [
            ...(r.get(PendingDynamicInstructionUserMessagesKey) ?? []),
            i.message,
          ]));
  }
  r.set(l, m);
}
export {
  buildDynamicInstructionMessages,
  dispatchDynamicInstructionEvent,
  drainDynamicInstructionUserMessages,
  prepareDynamicInstructionPreamble,
};
