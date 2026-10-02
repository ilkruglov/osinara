import { formatCompactTokenCount } from "../stream-format.js";
import { formatPayloadContent, wrapPlainText } from "./trace-content.js";
import { SURFACE_CLOSE } from "./trace-surfaces.js";
import { formatElapsed } from "#cli/format-elapsed.js";
import {
  clipVisible,
  stripTerminalControls,
  visibleLength,
} from "#cli/ui/terminal-text.js";
import { compareLocalTraceSpans } from "#tracing/local-trace-reader.js";
function buildConversationItems(e) {
  let t = new Map(e.spans.map((e) => [e.spanId, e])),
    n = new Map();
  for (let t of e.spans) {
    if (t.name !== `agent.turn`) continue;
    let e = stringAttribute(t, `agent.turn.id`),
      r = turnSubagent(t);
    e !== void 0 && r !== void 0 && n.set(e, r);
  }
  let r = [],
    i = [...e.spans]
      .sort(compareLocalTraceSpans)
      .find(
        (e) =>
          isModelSpan(e) && typeof e.attributes[`ai.prompt.system`] == `string`,
      ),
    a = i?.attributes[`ai.prompt.system`];
  i !== void 0 &&
    typeof a == `string` &&
    a.length > 0 &&
    r.push({
      item: {
        kind: `system`,
        durationMs: 0,
        error: !1,
        span: i,
        subagent: subagentFor(i, n, t),
        text: a,
      },
      order: 0n,
    });
  for (let i of e.spans) {
    let e = subagentFor(i, n, t);
    if (i.name === `agent.channel.delivery`) {
      let t = deliveryText(stringAttribute(i, `agent.channel.delivery.input`));
      if (t === void 0) continue;
      r.push({
        item: {
          kind: `user`,
          durationMs: spanDurationMs(i),
          error: i.statusCode === 2,
          span: i,
          subagent: e,
          text: t,
        },
        order: i.startTimeNs,
      });
      continue;
    }
    if (isModelSpan(i)) {
      let n = stringAttribute(i, `ai.response.text`),
        a = stringAttribute(i, `ai.response.reasoning`),
        s =
          numberAttribute(i, `agent.usage.input_tokens`) !== void 0 ||
          numberAttribute(i, `agent.usage.output_tokens`) !== void 0,
        c = i.attributes[`ai.response.tool_calls`] !== void 0;
      if (
        (n === void 0 || n.trim().length === 0) &&
        (a === void 0 || a.trim().length === 0) &&
        !s &&
        !c &&
        i.statusCode !== 2
      )
        continue;
      r.push({
        item: {
          kind: `assistant`,
          costUsd: stepCostUsd(i, t),
          durationMs: spanDurationMs(i),
          error: i.statusCode === 2,
          inputTokens: numberAttribute(i, `agent.usage.input_tokens`),
          model: stringAttribute(i, `gen_ai.request.model`),
          outputTokens: numberAttribute(i, `agent.usage.output_tokens`),
          reasoning: a,
          span: i,
          subagent: e,
          text: n,
          toolCallNames: c
            ? parseToolCallNames(stringAttribute(i, `ai.response.tool_calls`))
            : void 0,
        },
        order: i.startTimeNs,
      });
      for (let t of parseProviderToolResults(
        stringAttribute(i, `ai.response.tool_results`),
      ))
        r.push({
          item: {
            kind: `tool`,
            args: t.args,
            durationMs: 0,
            error: t.error,
            name: stripTerminalControls(t.name),
            result: t.result,
            span: i,
            subagent: e,
          },
          order: i.startTimeNs,
        });
      continue;
    }
    i.name === `agent.action` &&
      r.push({
        item: {
          kind: `tool`,
          args: stringAttribute(i, `gen_ai.tool.call.arguments`),
          durationMs: spanDurationMs(i),
          error: i.statusCode === 2,
          name: stripTerminalControls(
            stringAttribute(i, `agent.action.name`) ?? `action`,
          ),
          result: unwrapJsonString(
            stringAttribute(i, `gen_ai.tool.call.result`),
          ),
          span: i,
          subagent: e,
        },
        order: i.startTimeNs,
      });
  }
  return r
    .sort((e, t) => (e.order === t.order ? 0 : e.order < t.order ? -1 : 1))
    .map((e) => e.item);
}
function subagentFor(e, t, n) {
  let r = e;
  for (; r !== void 0; ) {
    let e = stringAttribute(r, `agent.turn.id`);
    if (e !== void 0) return t.get(e);
    r = r.parentSpanId === void 0 ? void 0 : n.get(r.parentSpanId);
  }
}
function turnSubagent(e) {
  let t = stringAttribute(e, `agent.parent.turn.id`);
  if (t === void 0) return;
  let n = stringAttribute(e, `agent.subagent.name`);
  return {
    name: n === void 0 ? void 0 : stripTerminalControls(n),
    parentCallId: stringAttribute(e, `agent.parent.call_id`),
    parentTurnId: t,
  };
}
function renderConversationItem(r, a, s, c, l, u) {
  let { colors: d, glyph: f } = s,
    p = Math.max(8, a - 8),
    m = conversationItemExpandable(r, a),
    h = s.color ? u : void 0,
    g = h?.primaryText ?? d.white,
    _,
    v,
    y = [];
  if (r.kind === `tool`) {
    let e = d.bold(g(r.name ?? `tool`));
    ((_ = `${foldMarker(l, m, s)}${e}`),
      (v = r.durationMs > 0 ? d.dim(formatElapsed(r.durationMs)) : ``));
    let n = r.args === void 0 ? [] : formatPayloadContent(r.args, p),
      a = r.result === void 0 ? [] : formatPayloadContent(r.result, p),
      o = l ? n : capLines(n, p),
      c = l ? a : capLines(a, p);
    (o.length > 0 && y.push(``, d.dim(`Input:`), ``, ...o),
      c.length > 0 && y.push(``, d.dim(`Output:`), ``, ...c));
  } else if (r.kind === `system`) {
    ((_ = `${foldMarker(l, m, s)}${d.bold(g(`system`))}`),
      (v = d.dim(
        `~${formatCompactTokenCount(estimateTokens(r.text ?? ``))} tokens`,
      )));
    let t = wrapPlainText(r.text ?? ``, p);
    y.push(...(l ? t : capLines(t, p)));
  } else if (r.kind === `assistant`) {
    ((_ = `${foldMarker(l, m, s)}${d.bold(g(`assistant`))}${r.model === void 0 ? `` : d.dim(` · ${stripTerminalControls(r.model)}`)}`),
      (v = assistantMetrics(r, f, d)));
    let e =
        r.reasoning === void 0 || r.reasoning.trim().length === 0
          ? []
          : wrapPlainText(r.reasoning, p),
      t =
        r.text === void 0 || r.text.trim().length === 0
          ? []
          : wrapPlainText(r.text, p),
      i = (l ? e : capLines(e, p)).map((e) => d.dim(e)),
      a = l ? t : capLines(t, p);
    if (
      (i.length > 0 &&
        (y.push(d.dim(`Thought:`), ``, ...i), a.length > 0 && y.push(``)),
      y.push(...a),
      (r.text === void 0 || r.text.trim().length === 0) &&
        r.toolCallNames !== void 0 &&
        r.toolCallNames.length > 0)
    ) {
      i.length > 0 && y.push(``);
      for (let e of r.toolCallNames) y.push(d.dim(`→ ${e}`));
    }
  } else {
    let e = r.kind === `user` && r.subagent !== void 0 ? `task` : r.kind;
    ((_ = `${foldMarker(l, m, s)}${d.bold(g(e))}`), (v = ``));
    let t =
      r.text === void 0 || r.text.trim().length === 0
        ? []
        : wrapPlainText(r.text, p);
    y.push(...(l ? t : capLines(t, p)));
  }
  if (r.subagent !== void 0) {
    let e =
      r.subagent.name === void 0 ? `subagent` : `subagent:${r.subagent.name}`;
    _ += d.dim(` · ${e}`);
  }
  (r.error && (_ += ` ${d.red(f.error)}`),
    !l && m
      ? y.push(`…`, ``, d.dim(`Click to expand`))
      : l && m && y.push(``, d.dim(`Click to collapse`)));
  let b = h === void 0 ? void 0 : r.error ? h.errorHeader : h.header,
    x = h === void 0 ? void 0 : r.error ? h.errorBody : h.body,
    S = railCell(s, c, r.error, h);
  return [
    cardRow(``, a, s, S, b),
    cardSplitRow(_, v, a, s, S, b),
    cardRow(``, a, s, S, b),
    cardRow(``, a, s, S, x),
    ...y.map((e) => cardRow(e, a, s, S, x)),
    cardRow(``, a, s, S, x),
  ];
}
function cardRow(e, t, n, i, o) {
  let c = clipVisible(e, Math.max(1, t - 8)),
    l = ` `.repeat(Math.max(0, t - 8 - visibleLength(c)));
  return o === void 0 || !n.color
    ? ` ${i}  ${c}${l}    `
    : ` ${i}${o}  ${c.replaceAll(`\x1B[0m`, `\x1b[0m${o}`)}\x1b[0m${o}${l}  ${SURFACE_CLOSE}  `;
}
function railCell(e, t, n, r) {
  let { colors: i, glyph: a } = e;
  if (t) {
    let t = e.unicode ? `▌` : a.rule;
    return r === void 0 ? i.white(t) : r.primaryText(t);
  }
  return r === void 0 ? (n ? i.red(a.rule) : i.dim(a.rule)) : ` `;
}
function cardSplitRow(e, t, n, r, i, o) {
  if (visibleLength(t) === 0) return cardRow(e, n, r, i, o);
  let c = Math.max(1, n - 8),
    l = visibleLength(t),
    u = clipVisible(e, Math.max(1, c - l - 2));
  return cardRow(
    `${u}${` `.repeat(Math.max(2, c - visibleLength(u) - l))}${t}`,
    n,
    r,
    i,
    o,
  );
}
function assistantMetrics(t, n, r) {
  let a = [];
  return (
    t.durationMs > 0 && a.push(formatElapsed(t.durationMs)),
    t.inputTokens !== void 0 &&
      a.push(`${n.arrowUp}${formatCompactTokenCount(t.inputTokens)}`),
    t.outputTokens !== void 0 &&
      a.push(`${n.arrowDown}${formatCompactTokenCount(t.outputTokens)}`),
    t.costUsd !== void 0 && a.push(formatCost(t.costUsd)),
    a.length === 0 ? `` : r.dim(a.join(` · `))
  );
}
function formatCost(e) {
  return e >= 0.01 ? `$${e.toFixed(2)}` : `$${e.toFixed(4)}`;
}
function stepCostUsd(e, t) {
  let n = e;
  for (; n.parentSpanId !== void 0; ) {
    if (((n = t.get(n.parentSpanId)), n === void 0)) return;
    if (n.name === `agent.step`) return numberAttribute(n, `gen_ai.usage.cost`);
  }
}
function foldMarker(e, t, n) {
  return e ? `${n.colors.dim(`▾`)} ` : t ? `${n.colors.dim(`▸`)} ` : ``;
}
function capLines(e, t) {
  return e.length <= 3
    ? [...e]
    : [...e.slice(0, 2), clipVisible(e[2], Math.max(1, t))];
}
function conversationItemLineCount(e, t, n, r) {
  return renderConversationItem(e, t, n, !1, r).length;
}
function conversationItemExpandable(e, r) {
  let i = Math.max(8, r - 8);
  if (e.kind === `tool`) {
    let n = e.args === void 0 ? 0 : formatPayloadContent(e.args, i - 2).length,
      r =
        e.result === void 0 ? 0 : formatPayloadContent(e.result, i - 2).length;
    return n > 3 || r > 3;
  }
  if (e.kind === `system`) return wrapPlainText(e.text ?? ``, i).length > 3;
  if (e.kind === `user`)
    return (
      (e.text === void 0 || e.text.trim().length === 0
        ? 0
        : wrapPlainText(e.text, i).length) > 3
    );
  let a =
      e.reasoning === void 0 || e.reasoning.trim().length === 0
        ? 0
        : wrapPlainText(e.reasoning, i).length,
    o =
      e.text === void 0 || e.text.trim().length === 0
        ? 0
        : wrapPlainText(e.text, i).length;
  return a > 3 || o > 3;
}
function estimateTokens(e) {
  return Math.ceil(e.length / 4);
}
function deliveryText(e) {
  if (e !== void 0)
    try {
      let t = JSON.parse(e);
      return isRecord(t) && typeof t.message == `string` ? t.message : void 0;
    } catch {
      return e;
    }
}
function unwrapJsonString(e) {
  if (e !== void 0)
    try {
      let t = JSON.parse(e);
      return typeof t == `string` ? t : e;
    } catch {
      return e;
    }
}
function isModelSpan(e) {
  return (
    (e.name.startsWith(`ai.`) && e.name.includes(`do`)) ||
    e.attributes[`gen_ai.operation.name`] === `chat`
  );
}
function parseToolCallNames(e) {
  if (e !== void 0)
    try {
      let t = JSON.parse(e);
      return Array.isArray(t)
        ? t
            .filter((e) => isRecord(e) && typeof e.toolName == `string`)
            .map((e) => e.toolName)
        : void 0;
    } catch {
      return;
    }
}
function parseProviderToolResults(e) {
  if (e === void 0) return [];
  try {
    let t = JSON.parse(e);
    if (!Array.isArray(t)) return [];
    let asText = (e) =>
      typeof e == `string` ? e : e === void 0 ? void 0 : JSON.stringify(e);
    return t.filter(isRecord).map((e) => {
      let t = `error` in e;
      return {
        args: asText(e.input),
        error: t,
        name: typeof e.toolName == `string` ? e.toolName : `tool`,
        result: asText(t ? e.error : e.output),
      };
    });
  } catch {
    return [];
  }
}
function stringAttribute(e, t) {
  let n = e.attributes[t];
  return typeof n == `string` ? n : void 0;
}
function numberAttribute(e, t) {
  let n = e.attributes[t];
  return typeof n == `number` ? n : void 0;
}
function spanDurationMs(e) {
  return Math.max(0, Number(e.endTimeNs - e.startTimeNs) / 1e6);
}
function isRecord(e) {
  return typeof e == `object` && !!e && !Array.isArray(e);
}
export {
  buildConversationItems,
  conversationItemExpandable,
  conversationItemLineCount,
  renderConversationItem,
};
