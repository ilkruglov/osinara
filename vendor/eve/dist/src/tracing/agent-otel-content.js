const CONTENT_ATTRIBUTE_LIMIT = 32 * 1024,
  CONTENT_NOISE_KEYS = new Set([`providerOptions`, `providerMetadata`]),
  TRUNCATED_MESSAGES_KEY = `eve.truncated`;
function contentAttribute(e, t = !0) {
  if (e === void 0) return;
  let n = t ? stripContentNoise(e, 0) : e,
    r;
  try {
    r = JSON.stringify(n);
  } catch {
    return;
  }
  if (r !== void 0) return textContentAttribute(r);
}
function messagesContentAttribute(e) {
  if (!Array.isArray(e)) return contentAttribute(e);
  let t = stripContentNoise(e, 0),
    r = stringifyContent(t);
  if (r !== void 0 && r.length <= 32768) return r;
  for (let e = 1; e < t.length; e += 1) {
    let r = stringifyContent([
      { [TRUNCATED_MESSAGES_KEY]: { omittedMessages: e } },
      ...t.slice(e),
    ]);
    if (r !== void 0 && r.length <= 32768) return r;
  }
  return truncateSingleMessage(t);
}
function genAiInputMessagesAttribute(e) {
  if (!Array.isArray(e)) return;
  let t = e.flatMap((e) => {
    if (!isRecord(e) || e.role === `system` || typeof e.role != `string`)
      return [];
    let t = semanticParts(e.content);
    return t.length === 0 ? [] : [{ parts: t, role: e.role }];
  });
  for (let e = 0; e < t.length; e += 1) {
    let n = semanticJsonAttribute(t.slice(e));
    if (n !== void 0) return n;
  }
  return semanticJsonAttribute([]);
}
function genAiSystemInstructionsAttribute(e) {
  let t = systemPromptAttribute(e);
  return t === void 0
    ? void 0
    : semanticJsonAttribute([{ content: t, type: `text` }]);
}
function genAiOutputMessagesAttribute(e, t) {
  let n = semanticParts(e);
  return semanticJsonAttribute([
    {
      finish_reason: t === `tool-calls` ? `tool_call` : t,
      parts: n,
      role: `assistant`,
    },
  ]);
}
function toolResultsContentAttribute(t) {
  if (t.length === 0) return;
  let n = stringifyContent(t);
  if (n !== void 0 && n.length <= 32768) return n;
  for (
    let n = CONTENT_ATTRIBUTE_LIMIT;
    n >= 0;
    n = n >= 256 ? Math.floor(n / 2) : -1
  ) {
    let e = stringifyContent(t.map((e) => cappedToolResult(e, n)));
    if (e !== void 0 && e.length <= 32768) return e;
  }
}
function cappedToolResult(e, t) {
  let n = { toolName: e.toolName };
  for (let r of [`input`, `output`, `error`]) {
    if (!(r in e)) continue;
    let i = e[r],
      a = typeof i == `string` ? i : (stringifyContent(i) ?? ``);
    n[r] = a.length <= t ? a : `${a.slice(0, t)}… [truncated]`;
  }
  return n;
}
function systemPromptAttribute(e) {
  if (typeof e == `string`) return textContentAttribute(e);
  if (!isRecord(e) && !Array.isArray(e)) return;
  let t = Array.isArray(e) ? e : [e],
    n = [];
  for (let e of t)
    if (isRecord(e)) {
      if (typeof e.content == `string`) n.push(e.content);
      else if (Array.isArray(e.content))
        for (let t of e.content)
          isRecord(t) &&
            t.type === `text` &&
            typeof t.text == `string` &&
            n.push(t.text);
    }
  let r = n
    .join(
      `

`,
    )
    .trim();
  return r.length === 0 ? void 0 : textContentAttribute(r);
}
function textContentAttribute(t) {
  if (t.length !== 0)
    return t.length <= 32768
      ? t
      : `${t.slice(0, CONTENT_ATTRIBUTE_LIMIT)}… [truncated]`;
}
function stripContentNoise(e, n) {
  if (n > 32 || typeof e != `object` || !e) return e;
  if (Array.isArray(e)) return e.map((e) => stripContentNoise(e, n + 1));
  let r = {};
  for (let [i, a] of Object.entries(e))
    CONTENT_NOISE_KEYS.has(i) || (r[i] = stripContentNoise(a, n + 1));
  return r;
}
function truncateSingleMessage(t) {
  if (t.length === 0) return;
  let r = t[t.length - 1];
  if (!isRecord(r)) return;
  let i = { [TRUNCATED_MESSAGES_KEY]: { omittedMessages: t.length - 1 } },
    a = typeof r.role == `string` ? r.role : `user`,
    o = ``;
  if (typeof r.content == `string`) o = r.content;
  else if (Array.isArray(r.content))
    for (let e of r.content)
      isRecord(e) &&
        e.type === `text` &&
        typeof e.text == `string` &&
        (o +=
          (o
            ? `
`
            : ``) + e.text);
  for (let t = Math.min(o.length, CONTENT_ATTRIBUTE_LIMIT); t > 0; t -= 256) {
    let e = stringifyContent([
      i,
      { role: a, content: t >= o.length ? o : `${o.slice(0, t)}… [truncated]` },
    ]);
    if (e !== void 0 && e.length <= 32768) return e;
  }
  return stringifyContent([i, { role: a, content: `` }]);
}
function stringifyContent(e) {
  try {
    return JSON.stringify(e);
  } catch {
    return;
  }
}
function semanticJsonAttribute(e) {
  let t = stringifyContent(e);
  return t !== void 0 && t.length <= 32768 ? t : void 0;
}
function semanticParts(e) {
  if (typeof e == `string`) return [{ content: e, type: `text` }];
  if (!Array.isArray(e)) return [];
  let t = [];
  for (let n of e) {
    let e = semanticPart(n);
    e !== void 0 && t.push(e);
  }
  return t;
}
function semanticPart(e) {
  if (!(!isRecord(e) || typeof e.type != `string`))
    switch (e.type) {
      case `text`:
      case `reasoning`: {
        let t = typeof e.text == `string` ? e.text : e.content;
        return typeof t == `string` ? { content: t, type: e.type } : void 0;
      }
      case `tool-call`:
        return {
          arguments: e.input,
          id: stringValue(e.toolCallId) ?? stringValue(e.callId) ?? null,
          name: e.toolName,
          type: `tool_call`,
        };
      case `tool-result`:
        return {
          id: stringValue(e.toolCallId) ?? stringValue(e.callId) ?? null,
          response: toolResponse(e.output),
          type: `tool_call_response`,
        };
      case `tool-error`:
        return {
          id: stringValue(e.toolCallId) ?? stringValue(e.callId) ?? null,
          response: e.error instanceof Error ? e.error.message : e.error,
          type: `tool_call_response`,
        };
      default:
        return { type: e.type };
    }
}
function toolResponse(e) {
  return isRecord(e)
    ? (e.type === `text` ||
        e.type === `error-text` ||
        e.type === `json` ||
        e.type === `error-json`) &&
      `value` in e
      ? e.value
      : e.type === `execution-denied`
        ? { denied: !0, reason: e.reason }
        : e
    : e;
}
function stringValue(e) {
  return typeof e == `string` ? e : void 0;
}
function isRecord(e) {
  return typeof e == `object` && !!e && !Array.isArray(e);
}
export {
  CONTENT_ATTRIBUTE_LIMIT,
  contentAttribute,
  genAiInputMessagesAttribute,
  genAiOutputMessagesAttribute,
  genAiSystemInstructionsAttribute,
  messagesContentAttribute,
  systemPromptAttribute,
  textContentAttribute,
  toolResultsContentAttribute,
};
