import { createLogger } from "#internal/logging.js";
import {
  LiveStepToolsKey,
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  SessionIdKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  serializeInputSchema,
  serializeOutputSchema,
  toInputSchema,
  toOutputSchema,
} from "#shared/tool-schema.js";
import {
  ALLOWED_DYNAMIC_TOOL_EVENTS,
  isBrandedToolEntry,
} from "#shared/dynamic-tool-definition.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { buildResolveContext } from "#context/dynamic-resolve-context.js";
import { resolveApprovalPolicy } from "#public/definitions/approval.js";
const log = createLogger(`dynamic-tools`);
function toHarnessToolDefinition(e, t) {
  return {
    description: t.description,
    execute: createToolExecuteWithAuth({
      scope: e,
      execute: (e, n) => t.execute(e, n),
    }),
    inputSchema: toInputSchema(t.inputSchema),
    name: e,
    approval: t.approval,
    outputSchema: toOutputSchema(t.outputSchema),
    ...(t.toModelOutput === void 0 ? {} : { toModelOutput: t.toModelOutput }),
  };
}
function qualifyDynamicToolNames(e, t, n) {
  let r = Object.keys(n),
    i = [];
  if (r.length === 0) return i;
  if (t) return (i.push({ name: e.slug, entryKey: r[0], entry: n[r[0]] }), i);
  let a = e.extensionNamespace === void 0 ? `` : `${e.extensionNamespace}__`;
  for (let e of r) i.push({ name: `${a}${e}`, entryKey: e, entry: n[e] });
  return i;
}
function replayDynamicSessionTools(e, t) {
  let n = [];
  for (let t of e) {
    if (!t.executeStepFnName || !t.closureVars) {
      log.warn(
        `Dynamic tool "${t.name}" has no registered step function — skipping on this step. The bundler transform may not have processed this tool file.`,
      );
      continue;
    }
    let e = lookupStepFunction(t.executeStepFnName);
    if (!e) {
      log.warn(
        `Dynamic tool "${t.name}" references step function "${t.executeStepFnName}" which is not registered — skipping on this step.`,
      );
      continue;
    }
    n.push({
      description: t.description,
      execute: createToolExecuteWithAuth({
        scope: t.name,
        execute: (n, r) => e(t.closureVars, n, r),
      }),
      inputSchema: toInputSchema(t.inputSchema),
      name: t.name,
      outputSchema: toOutputSchema(t.outputSchema),
    });
  }
  return n;
}
function getStepRegistry() {
  let e = Symbol.for(`@workflow/core//registeredSteps`),
    t = globalThis,
    n = t[e];
  return (n === void 0 && ((n = new Map()), (t[e] = n)), n);
}
function lookupStepFunction(e) {
  try {
    return getStepRegistry().get(e) || null;
  } catch {
    return null;
  }
}
function hasMissingProcessCallback(e) {
  return (
    (e.executeStepFnName?.startsWith(`eve:framework-dynamic:`) === !0 &&
      lookupStepFunction(e.executeStepFnName) === null) ||
    (e.approvalStepFnName !== void 0 &&
      lookupStepFunction(e.approvalStepFnName) === null) ||
    (e.approvalResponseStepFnName !== void 0 &&
      lookupStepFunction(e.approvalResponseStepFnName) === null)
  );
}
const processCallbackQueue = [],
  processCallbackGroups = new Map();
function registerProcessCallbacks(e, t) {
  let n = getStepRegistry(),
    r = processCallbackGroups.get(e);
  if (r !== void 0) for (let e of r.callbackIds) n.delete(e);
  if (t.size === 0) {
    processCallbackGroups.delete(e);
    return;
  }
  let i = { id: e, callbackIds: new Set(t.keys()) };
  (processCallbackGroups.set(e, i), processCallbackQueue.push(i));
  for (let [e, r] of t) n.set(e, r);
  for (; processCallbackQueue.length > 256; ) {
    let e = processCallbackQueue.shift();
    if (processCallbackGroups.get(e.id) === e) {
      processCallbackGroups.delete(e.id);
      for (let t of e.callbackIds) n.delete(t);
    }
  }
}
function safeSerialize(e) {
  try {
    return JSON.parse(JSON.stringify(e));
  } catch {
    return {};
  }
}
function durableKeyForEvent(e) {
  switch (e) {
    case `session.started`:
      return SessionDynamicToolMetadataKey;
    case `turn.started`:
      return TurnDynamicToolMetadataKey;
    default:
      return;
  }
}
function readDynamicToolResult(e, t) {
  if (isBrandedToolEntry(t)) return { entries: { _single: t }, isSingle: !0 };
  if (typeof t != `object` || !t || Array.isArray(t))
    throw Error(
      `Dynamic tool resolver "${e.logicalPath}" must return defineTool(), a map of defineTool() values, or null.`,
    );
  let n = {};
  for (let [r, i] of Object.entries(t)) {
    if (!isBrandedToolEntry(i))
      throw Error(
        `Dynamic tool resolver "${e.logicalPath}" returned "${r}" without defineTool(). Wrap every dynamic tool entry in defineTool().`,
      );
    n[r] = i;
  }
  return { entries: n, isSingle: !1 };
}
async function resolveToolsFromEvent(e, t, n, r) {
  let a = await Promise.allSettled(
      t.map(async (t) => {
        let i = t.events[n.type];
        if (i === void 0) return null;
        let a = await i(n, buildResolveContext(e, r));
        if (a == null) return null;
        let { entries: o, isSingle: s } = readDynamicToolResult(t, a);
        return { resolver: t, entries: o, isSingle: s };
      }),
    ),
    l = [],
    u = [],
    d = new Map();
  for (let t of a) {
    if (t.status === `rejected`) {
      log.error(`Dynamic tool resolver (${n.type}) threw — skipping.`, {
        error: toErrorMessage(t.reason),
      });
      continue;
    }
    if (t.value === null) continue;
    let { resolver: r, entries: a, isSingle: f } = t.value,
      p = qualifyDynamicToolNames(r, f, a),
      m = new Map();
    for (let { name: t, entryKey: a, entry: o } of p) {
      let f = d.get(t);
      if (f !== void 0 && f !== r.slug)
        throw Error(
          `Dynamic tool "${t}" from resolver "${r.slug}" collides with dynamic resolver "${f}". Namespace the map key manually, e.g. "${r.slug}__${t}".`,
        );
      if (
        (d.set(t, r.slug),
        u.push(toHarnessToolDefinition(t, o)),
        n.type === `step.started`)
      )
        continue;
      let p = `__executeStepFn` in o ? o.__executeStepFn : void 0,
        h = `__closureVars` in o ? o.__closureVars : void 0,
        g = p?.stepId,
        _ = h === void 0 ? void 0 : safeSerialize(h),
        v = n.type === `session.started` ? `${e.require(SessionIdKey)}:` : ``;
      if (g === void 0) {
        let e = `eve:framework-dynamic:${v}${r.slug}:${a}`,
          t = o.execute.bind(o);
        (m.set(e, (e, n, r) => t(n, r)), (g = e), (_ = {}));
      }
      let y, b;
      if (o.approval !== void 0) {
        y = `eve:dynamic-tool-approval:${v}${r.slug}:${a}`;
        let e = resolveApprovalPolicy(o.approval).bind(o);
        m.set(y, (t, n) => e(n));
        let t = typeof o.approval == `function` ? void 0 : o.approval.response;
        t !== void 0 &&
          ((b = `eve:dynamic-tool-approval-response:${v}${r.slug}:${a}`),
          m.set(b, (e, n) => t(n)));
      }
      l.push({
        name: t,
        description: o.description,
        inputSchema: serializeInputSchema(o.inputSchema),
        outputSchema: serializeOutputSchema(o.outputSchema),
        resolverSlug: r.slug,
        entryKey: a,
        executeStepFnName: g,
        approvalStepFnName: y,
        approvalResponseStepFnName: b,
        closureVars: _,
      });
    }
    if (n.type === `session.started`)
      registerProcessCallbacks(`${e.require(SessionIdKey)}:${r.slug}`, m);
    else for (let [e, t] of m) getStepRegistry().set(e, t);
  }
  return { metadata: l, liveTools: u };
}
const resolvedStepTools = new WeakMap();
async function resolveStepDynamicTools(e) {
  let n = `data` in e.event ? e.event.data : void 0,
    r =
      typeof n?.turnId == `string` && typeof n.stepIndex == `number`
        ? `${n.turnId}:${String(n.stepIndex)}`
        : void 0,
    i = resolvedStepTools.get(e.ctx);
  if (r !== void 0 && i?.coordinate === r) {
    e.ctx.setVirtualContext(LiveStepToolsKey, i.tools);
    return;
  }
  let a = e.resolvers.filter((e) => e.eventNames.includes(`step.started`)),
    { liveTools: o } =
      a.length === 0
        ? { liveTools: [] }
        : await resolveToolsFromEvent(e.ctx, a, e.event, e.messages);
  (e.ctx.setVirtualContext(LiveStepToolsKey, o),
    r !== void 0 && resolvedStepTools.set(e.ctx, { coordinate: r, tools: o }));
}
async function dispatchDynamicToolEvent(e) {
  let { ctx: t, resolvers: r, event: i, messages: a } = e;
  if (!ALLOWED_DYNAMIC_TOOL_EVENTS.has(i.type)) return;
  if (i.type === `step.started`) {
    await resolveStepDynamicTools(e);
    return;
  }
  let o = r.filter((e) => e.eventNames.includes(i.type));
  if (o.length === 0) {
    i.type === `session.started` && t.set(SessionDynamicToolMetadataKey, []);
    return;
  }
  let { metadata: s } = await resolveToolsFromEvent(t, o, i, a),
    c = durableKeyForEvent(i.type);
  if (c === void 0) return;
  if (i.type === `session.started`) {
    t.set(SessionDynamicToolMetadataKey, s);
    return;
  }
  let l = new Set(o.map((e) => e.slug)),
    u = (t.get(c) ?? []).filter((e) => !l.has(e.resolverSlug));
  t.set(c, [...u, ...s]);
}
async function refreshDynamicSessionToolsForRuntimeRevision(e) {
  if (e.ctx.get(SessionDynamicToolRuntimeRevisionKey) === e.runtimeRevision)
    return;
  let t = e.resolvers.filter((e) => e.eventNames.includes(`session.started`)),
    { metadata: i } =
      t.length === 0
        ? { metadata: [] }
        : await resolveToolsFromEvent(e.ctx, t, e.event, e.messages);
  (e.ctx.set(SessionDynamicToolMetadataKey, i),
    e.ctx.set(SessionDynamicToolRuntimeRevisionKey, e.runtimeRevision));
}
async function hydrateDynamicSessionTools(e) {
  let t = e.ctx.get(SessionDynamicToolMetadataKey) ?? [],
    r = t.filter(hasMissingProcessCallback);
  if (r.length === 0) return;
  let i = new Set(r.map((e) => e.resolverSlug)),
    a = e.resolvers.filter(
      (e) => e.eventNames.includes(`session.started`) && i.has(e.slug),
    ),
    { metadata: o } =
      a.length === 0
        ? { metadata: [] }
        : await resolveToolsFromEvent(e.ctx, a, e.event, e.messages),
    s = new Map(t.map((e) => [e.name, e.resolverSlug])),
    c = new Map(o.map((e) => [e.name, e.resolverSlug]));
  if (o.some((e) => s.get(e.name) !== e.resolverSlug))
    throw Error(
      `Dynamic session tool callback hydration changed durable ownership.`,
    );
  r.some(
    (e) => c.get(e.name) !== e.resolverSlug || hasMissingProcessCallback(e),
  ) &&
    log.warn(
      `Dynamic session tool callback hydration did not reproduce durable ownership.`,
    );
}
export {
  dispatchDynamicToolEvent,
  hydrateDynamicSessionTools,
  refreshDynamicSessionToolsForRuntimeRevision,
  replayDynamicSessionTools,
  resolveStepDynamicTools,
};
