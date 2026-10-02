import { generateText } from "ai";
import { estimateTokens } from "#harness/token-estimate.js";
import {
  COMPACTION_CHECKPOINT_MARKER,
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_RESUMPTION_MESSAGE,
  TODO_COMPACTION_PRESERVATION_LABEL,
  TRANSCRIPT_PAYLOAD_LIMIT,
  createCompactionPrompt,
  stubContentOutputFileParts,
} from "#harness/compaction-prompt.js";
const COMPACTION_PROMPT_OVERHEAD_TOKENS = estimateTokens([
  { content: COMPACTION_PROMPT_ENVELOPE.system, role: `system` },
  { content: COMPACTION_PROMPT_ENVELOPE.prompt, role: `user` },
]);
function getInputTokenCount(e, n) {
  let r = n.lastKnownInputTokens,
    i = n.lastKnownPromptMessageCount;
  return r === void 0 ||
    i === void 0 ||
    !Number.isInteger(i) ||
    i < 0 ||
    i > e.length
    ? estimateTokens(e)
    : r + estimateTokens(e.slice(i));
}
function shouldCompact(e, t, i) {
  let n = getInputTokenCount(e, t),
    r = e.length > 0 && n + COMPACTION_PROMPT_OVERHEAD_TOKENS > t.threshold;
  console.info(
    JSON.stringify({
      code: "AGENT_COMPACTION_CHECK",
      sessionId: i?.sessionId ?? null,
      turnId: i?.turnId ?? null,
      compact: r,
      estimatedInputTokens: Math.round(n),
      lastKnownInputTokens: t.lastKnownInputTokens ?? null,
      lastKnownPromptMessageCount: t.lastKnownPromptMessageCount ?? null,
      messages: e.length,
      overheadTokens: Math.round(COMPACTION_PROMPT_OVERHEAD_TOKENS),
      threshold: t.threshold,
    }),
  );
  return r;
}
async function resolveCompactionModel(e) {
  let t = e.compactionModelReference ?? e.modelReference;
  return {
    model: t === e.modelReference ? e.model : await e.resolveModel(t),
    providerOptions: t.providerOptions,
  };
}
const COMPACTION_HEURISTICS = [toolResultCapHeuristic];
function toolResultCapHeuristic(e) {
  let c = capToolResults(e.older),
    t = withResumptionGuard(
      [
        ...(e.previousCheckpoint === void 0
          ? []
          : [
              { content: COMPACTION_CHECKPOINT_MARKER, role: `user` },
              { content: e.previousCheckpoint, role: `assistant` },
            ]),
        ...c,
        ...e.recent,
      ],
      e.conversation,
    ),
    s = Math.max(0, estimateTokens(e.older) - estimateTokens(c)),
    a =
      typeof e.realBefore == `number`
        ? e.realBefore - s + COMPACTION_PROMPT_OVERHEAD_TOKENS
        : evaluateThreshold(t, e.config, `should-compact`).estimatedTokens,
    w = a <= e.config.threshold;
  console.info(
    JSON.stringify({
      code: "AGENT_COMPACTION_HEURISTIC",
      realBefore:
        typeof e.realBefore == `number` ? Math.round(e.realBefore) : null,
      savedTokens: Math.round(s),
      realAfter: Math.round(a),
      threshold: e.config.threshold,
      within: w,
    }),
  );
  return w ? { messages: t, type: `within-limit` } : { type: `insufficient` };
}
function evaluateThreshold(e, n, r) {
  let i = r === `should-compact` ? COMPACTION_PROMPT_OVERHEAD_TOKENS : 0,
    a = estimateTokens(e) + i;
  return {
    estimatedTokens: a,
    type: a <= n.threshold ? `within-limit` : `over-limit`,
  };
}
async function compactMessages(t, r, i, a, o, c, l, d = !1) {
  let { conversation: f, previousCheckpoint: p } = extractPreviousCheckpoint(t),
    R = getInputTokenCount(t, i),
    m = selectRecentWindowSize(f, d ? { ...i, recentWindowSize: 1 } : i);
  if (!d) {
    let { older: e, recent: t } = splitMessagesForCompaction(f, m);
    if (e.length === 0 && p === void 0) return keepNonToolResultMessages(t);
    for (let n of COMPACTION_HEURISTICS) {
      let r = n({
        config: i,
        conversation: f,
        older: e,
        previousCheckpoint: p,
        realBefore: R,
        recent: t,
      });
      if (r.type === `within-limit`) return r.messages;
    }
  }
  for (;;) {
    let { older: t, recent: u } = splitMessagesForCompaction(f, m),
      d = createCompactionPrompt({
        messages: t,
        previousCheckpoint: p,
        transcriptBudgetTokens: i.threshold,
      }),
      h = await generateText({
        abortSignal: l,
        headers: c,
        model: r,
        prompt: d.prompt,
        providerOptions: a,
        system: d.system,
        telemetry: o ? { ...o, functionId: `eve.compaction` } : void 0,
        temperature: 0,
      }),
      g = [
        { content: COMPACTION_CHECKPOINT_MARKER, role: `user` },
        { content: h.text, role: `assistant` },
      ],
      _ = withResumptionGuard([...g, ...u], f);
    if (evaluateThreshold(_, i, `estimate`).type === `within-limit`) return _;
    let v = withResumptionGuard([...g, ...keepNonToolResultMessages(u)], f);
    if (evaluateThreshold(v, i, `estimate`).type === `within-limit`) return v;
    console.error(
      JSON.stringify({
        code: "AGENT_COMPACTION_OUTPUT_OVER_LIMIT",
        estimatedTokens: Math.round(
          evaluateThreshold(v, i, `estimate`).estimatedTokens,
        ),
        threshold: i.threshold,
      }),
    );
    return v;
  }
}
function capToolResults(e) {
  return e.map((e) => {
    if (e.role !== `tool` || typeof e.content == `string`) return e;
    let t = !1,
      n = e.content.map((e) => {
        if (e.type !== `tool-result`) return e;
        if (
          e.output?.type === `text` &&
          typeof e.output.value == `string` &&
          e.output.value.startsWith(`[Truncated by eve:`)
        )
          return e;
        let n = stubContentOutputFileParts(e.output),
          r = JSON.stringify(n) ?? ``;
        return r.length <= TRANSCRIPT_PAYLOAD_LIMIT
          ? n === e.output
            ? e
            : ((t = !0), { ...e, output: n })
          : ((t = !0),
            {
              ...e,
              output: {
                type: `text`,
                value: `[Truncated by eve: tool result reduced during context compaction. Re-run the tool if you need the full output.]\n\n${r.slice(0, TRANSCRIPT_PAYLOAD_LIMIT)}`,
              },
            });
      });
    return t ? { ...e, content: n } : e;
  });
}
function withResumptionGuard(e, t) {
  let n = e.at(-1)?.role;
  if (n !== void 0 && n !== `assistant`) return e;
  let r = findLastRealUserMessage(t),
    a =
      r !== void 0 &&
      e.some((e) => e.role === `user` && e.content === r.content);
  return [
    ...e,
    r !== void 0 && !a
      ? r
      : { content: COMPACTION_RESUMPTION_MESSAGE, role: `user` },
  ];
}
function findLastRealUserMessage(e) {
  for (let t = e.length - 1; t >= 0; --t) {
    let r = e[t];
    if (
      !(r?.role !== `user` || typeof r.content != `string`) &&
      !(
        r.content === COMPACTION_RESUMPTION_MESSAGE ||
        r.content === COMPACTION_CHECKPOINT_MARKER ||
        r.content.startsWith(TODO_COMPACTION_PRESERVATION_LABEL)
      )
    )
      return r;
  }
}
function extractPreviousCheckpoint(e) {
  let t = e[0],
    r = e[1];
  return t?.role !== `user` ||
    t.content !== COMPACTION_CHECKPOINT_MARKER ||
    r?.role !== `assistant`
    ? { conversation: [...e], previousCheckpoint: void 0 }
    : { conversation: e.slice(2), previousCheckpoint: assistantMessageText(r) };
}
function keepNonToolResultMessages(e) {
  let t = [];
  for (let n of e)
    if (n.role !== `tool`) {
      if (n.role === `assistant`) {
        let e = assistantMessageText(n);
        e.length > 0 && t.push({ content: e, role: `assistant` });
        continue;
      }
      t.push(n);
    }
  return t;
}
function assistantMessageText(e) {
  return typeof e.content == `string`
    ? e.content.trim()
    : e.content
        .filter((e) => e.type === `text`)
        .map((e) => e.text)
        .join(``)
        .trim();
}
function selectRecentWindowSize(e, n) {
  let r = Math.min(n.recentWindowSize, Math.max(e.length - 1, 0)),
    i = resolveCompactionSummaryReserve(n),
    a = 0,
    o = 0;
  for (let s = e.length - 1; s >= 0 && a < r; --s) {
    let r = e[s];
    if (r === void 0) continue;
    let c = estimateTokens([r]);
    if (o + c + i > n.threshold) break;
    ((o += c), (a += 1));
  }
  return a;
}
function resolveCompactionSummaryReserve(e) {
  return Math.min(2048, Math.max(64, Math.floor(e.threshold / 4)));
}
function splitMessagesForCompaction(e, t) {
  if (t <= 0) return { older: [...e], recent: [] };
  let n = e.length - t;
  for (; n < e.length && e[n]?.role === `tool`; ) n += 1;
  return { older: e.slice(0, n), recent: e.slice(n) };
}
export {
  compactMessages,
  getInputTokenCount,
  resolveCompactionModel,
  shouldCompact,
};
