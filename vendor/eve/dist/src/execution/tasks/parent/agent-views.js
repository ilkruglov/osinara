import { resolveAgentsAnnouncement } from "#harness/handles/prompt.js";
import {
  formatAgentStatus,
  getAgentHandleStore,
} from "#harness/handles/store.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";
import { readTaskViews } from "#execution/tasks/parent/control-shared.js";
async function readTaskAgentViews(e) {
  let a = (getAgentHandleStore(e.state)?.handles ?? []).filter(
    (e) => e.phase === `addressed`,
  );
  if (a.length === 0) return [];
  let o = await readTaskViews(getSessionTaskIndex(e.state)),
    s = new Map();
  for (let e of o) {
    let t = s.get(e.metadata.agentId) ?? [];
    s.set(e.metadata.agentId, [...t, e]);
  }
  return a.map((e) => {
    let n = s.get(e.identity.id) ?? [],
      r = n.filter(
        (e) => e.status === `working` || e.status === `input_required`,
      );
    if (r.length > 1)
      throw Error(
        `Agent "${e.identity.id}" has more than one nonterminal task.`,
      );
    let i = r[0];
    if (i !== void 0) {
      let t = i.status === `input_required` ? `input_required` : `working`;
      return {
        availability: `busy`,
        id: e.identity.id,
        name: e.identity.name,
        taskId: i.taskId,
        taskStatus: t,
      };
    }
    let a = n.at(-1);
    return {
      availability: `available`,
      id: e.identity.id,
      name: e.identity.name,
      statusLine:
        a?.lastOutput === void 0
          ? void 0
          : formatAgentStatus(a.lastOutput.data),
    };
  });
}
async function appendTaskAgentAnnouncement(t) {
  let r = resolveAgentsAnnouncement({
    agentViews: await readTaskAgentViews(t),
    messages: t.history,
    store: getAgentHandleStore(t.state),
  });
  return r === void 0
    ? t
    : { ...t, history: [...t.history, { content: r, role: `user` }] };
}
export { appendTaskAgentAnnouncement, readTaskAgentViews };
