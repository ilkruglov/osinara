import { INTERNAL_CHANNEL_DELIVER } from "#channel/channel-operations.js";
import { parseJsonValue } from "#shared/json.js";
import {
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  invocationInputRequestId,
  invocationOwnerKey,
} from "#internal/invocation/metadata.js";
var WorkflowAgentInvocationExecution = class {
  #e;
  #t;
  constructor(e) {
    ((this.#e = e.createSession), (this.#t = e.from));
  }
  async create(e) {
    let t = `invocation:${crypto.randomUUID()}`,
      n = await this.#e({
        auth: e.auth,
        capabilities: { requestInput: !0 },
        continuationToken: t,
        externalInvocation: {
          continuationToken: t,
          ownerKey: invocationOwnerKey(e.auth),
        },
        input: { message: e.message, outputSchema: e.outputSchema },
        mode: `task`,
      }),
      r = await this.#n(n.sessionId, e.auth);
    if (r === void 0)
      throw Error(`Invocation run was unavailable after durable creation.`);
    return workingInvocation(
      n.sessionId,
      r.createdAt.toISOString(),
      r.expiredAt?.toISOString(),
    );
  }
  async read(e) {
    let t = await this.#n(e.invocationId, e.auth);
    if (t === void 0) return;
    if (isTerminalRunStatus(t.status)) return await terminalInvocation(t);
    let n = await readRecentPersistedEvents(e.invocationId);
    return projectNonterminal(
      t.runId,
      t.createdAt.toISOString(),
      t.expiredAt?.toISOString(),
      n,
    );
  }
  async update(t) {
    let r = await this.read(t);
    if (r === void 0) return { type: `not_found` };
    if (r.status !== `input_required`)
      return conflict(`Invocation is not waiting for input.`);
    let i = await this.#n(t.invocationId, t.auth);
    if (i === void 0) return { type: `not_found` };
    let a = latestPendingInputBatch(
      await readRecentPersistedEvents(t.invocationId),
    );
    if (a === void 0)
      return conflict(
        `Invocation input changed before the update could be applied.`,
      );
    let o = new Set(),
      s = [];
    for (let e of t.responses) {
      let t = a.rawRequestIds[e.requestId];
      if (t === void 0)
        return conflict(`Unknown input request: ${e.requestId}`);
      (o.add(e.requestId), s.push({ ...e, requestId: t }));
    }
    if (
      o.size !== t.responses.length ||
      o.size !== Object.keys(a.requests).length
    )
      return conflict(
        `Responses must answer the complete pending input batch exactly once.`,
      );
    let l = i.attributes[INVOCATION_TOKEN_ATTRIBUTE];
    if (l === void 0) return { type: `not_found` };
    try {
      await this.#t(l)[INTERNAL_CHANNEL_DELIVER](
        { inputResponses: s },
        { auth: t.auth },
      );
    } catch (e) {
      if (RunExpiredError.is(e)) return { type: `not_found` };
      throw e;
    }
    return {
      invocation: workingInvocation(t.invocationId, r.createdAt, r.expiresAt),
      type: `success`,
    };
  }
  async cancel(e) {
    let t = await this.read(e);
    if (t === void 0 || isTerminal(t.status)) return t;
    try {
      await getRun(e.invocationId).cancel();
    } catch (e) {
      if (WorkflowRunNotFoundError.is(e) || RunExpiredError.is(e)) return;
      throw e;
    }
    return await this.read(e);
  }
  async #n(e, t) {
    let i = await getWorld();
    try {
      let n = await i.runs.get(e);
      return n.attributes[INVOCATION_TOKEN_ATTRIBUTE] === void 0
        ? void 0
        : n.attributes[INVOCATION_OWNER_ATTRIBUTE] === invocationOwnerKey(t)
          ? n
          : void 0;
    } catch (e) {
      if (WorkflowRunNotFoundError.is(e) || RunExpiredError.is(e)) return;
      throw e;
    }
  }
};
async function readRecentPersistedEvents(e) {
  let t = getRun(e).getReadable({ startIndex: -64 }),
    n = await t.getTailIndex();
  if (n < 0)
    return (
      await t.cancel(`invocation event stream is empty`).catch(() => {}),
      []
    );
  let r = Math.min(n + 1, 64),
    a = parseNdjsonStream(() => t).getReader(),
    s = [];
  try {
    for (; s.length < r; ) {
      let { done: e, value: t } = await a.read();
      if (e) break;
      s.push(t);
    }
  } finally {
    (await a.cancel(`invocation event window read complete`).catch(() => {}),
      a.releaseLock());
  }
  return s;
}
function pendingInputBatch(e) {
  let t = {},
    n = {};
  for (let r of e.data.requests) {
    let i = invocationInputRequestId(e.meta.id, r.requestId);
    ((t[i] = r.requestId), (n[i] = { ...r, requestId: i }));
  }
  return { id: e.meta.id, rawRequestIds: t, requests: n };
}
function latestPendingInputBatch(e) {
  let t;
  for (let n of e)
    n.type === `input.requested`
      ? (t = pendingInputBatch(n))
      : n.type === `turn.started` && (t = void 0);
  return t;
}
function projectNonterminal(e, t, n, r) {
  let i = new Map(),
    a,
    o;
  for (let e of r)
    if (e.type === `input.requested`) a = pendingInputBatch(e);
    else if (e.type === `turn.started`) (i.clear(), (a = void 0), (o = void 0));
    else if (e.type === `authorization.required`) {
      let t = { description: e.data.description, name: e.data.name };
      (e.data.authorization !== void 0 &&
        (t.authorization = e.data.authorization),
        e.data.webhookUrl !== void 0 && (t.webhookUrl = e.data.webhookUrl),
        i.set(e.data.name, t));
    } else
      e.type === `authorization.completed`
        ? i.delete(e.data.name)
        : e.type === `message.completed` &&
          e.data.finishReason !== `tool-calls` &&
          e.data.message !== null &&
          (o = safeJson(e.data.message));
  let s = [...i.values()],
    c = { createdAt: t, expiresAt: n, invocationId: e, result: o };
  return s.length > 0
    ? {
        ...c,
        authorizations: s,
        pollAfterMs: 1e3,
        status: `authorization_required`,
      }
    : a === void 0
      ? { ...c, pollAfterMs: 1e3, status: `working` }
      : { ...c, inputRequests: a.requests, status: `input_required` };
}
async function terminalInvocation(e) {
  let t = {
    createdAt: e.createdAt.toISOString(),
    expiresAt: e.expiredAt?.toISOString(),
    invocationId: e.runId,
  };
  if (e.status === `cancelled`) return { ...t, status: `cancelled` };
  if (e.status === `failed`)
    return {
      ...t,
      error: {
        code: -32603,
        data: safeJson(e.error),
        message: errorMessage(e.error),
      },
      status: `failed`,
    };
  let n = await getRun(e.runId).returnValue;
  return { ...t, result: safeJson(n.output), status: `completed` };
}
function workingInvocation(e, t, n) {
  return {
    createdAt: t,
    expiresAt: n,
    invocationId: e,
    pollAfterMs: 1e3,
    status: `working`,
  };
}
function safeJson(e) {
  try {
    return parseJsonValue(e);
  } catch {
    return String(e);
  }
}
function errorMessage(e) {
  return e instanceof Error ? e.message : `Session failed.`;
}
function conflict(e) {
  return { message: e, type: `conflict` };
}
function isTerminal(e) {
  return e === `completed` || e === `failed` || e === `cancelled`;
}
function isTerminalRunStatus(e) {
  return e === `completed` || e === `failed` || e === `cancelled`;
}
export { WorkflowAgentInvocationExecution };
