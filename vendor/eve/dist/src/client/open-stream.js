import { createEveSessionStreamRoutePath } from "#protocol/routes.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/message.js";
import { isStreamDisconnectError, readNdjsonStream } from "#client/ndjson.js";
import { ClientError } from "#client/client-error.js";
import { createClientUrl } from "#client/url.js";
const DEFAULT_STREAM_RECONNECT_POLICY = {
    retryableErrorStatuses: new Set([404, 409, 425, 500, 502, 503, 504]),
    streamIdleReconnectPolicy: {
      baseDelayMs: 250,
      maxAttempts: 5,
      maxDelayMs: 4e3,
    },
    streamOpenReconnectPolicy: {
      baseDelayMs: 250,
      maxAttempts: 12,
      maxDelayMs: 5e3,
    },
  },
  NO_STREAM_RECONNECT_POLICY = {
    ...DEFAULT_STREAM_RECONNECT_POLICY,
    streamIdleReconnectPolicy: {
      ...DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy,
      maxAttempts: 0,
    },
    streamOpenReconnectPolicy: {
      ...DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy,
      maxAttempts: 1,
    },
  };
function resolveRetryPolicy(e, t) {
  return { ...t, ...e };
}
function resolveStreamReconnectPolicy(e) {
  if (e && `reconnect` in e && e.reconnect === !1)
    return NO_STREAM_RECONNECT_POLICY;
  let t = e;
  return {
    retryableErrorStatuses: t?.retryableErrorStatuses
      ? new Set(t.retryableErrorStatuses)
      : DEFAULT_STREAM_RECONNECT_POLICY.retryableErrorStatuses,
    streamIdleReconnectPolicy: resolveRetryPolicy(
      t?.streamIdleReconnectPolicy,
      DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy,
    ),
    streamOpenReconnectPolicy: resolveRetryPolicy(
      t?.streamOpenReconnectPolicy,
      DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy,
    ),
  };
}
async function* followStreamIterable(e) {
  if (e.follow === !1 && e.startIndex < 0)
    throw Error(
      `stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.`,
    );
  let i = resolveStreamReconnectPolicy(e.streamReconnectPolicy),
    a = i.streamIdleReconnectPolicy,
    o = e.startIndex,
    s = a.baseDelayMs,
    c = 0,
    l = !0,
    u;
  for (;;) {
    let d;
    try {
      d = await openStreamBody({
        ...e,
        retryPolicy: i,
        startIndex: o,
        requestTailIndex: e.follow === !1 && u === void 0,
      });
    } catch (t) {
      if (e.signal?.aborted) return;
      throw t;
    }
    if (e.follow === !1 && u === void 0 && ((u = d.tailIndex), u === void 0))
      throw (
        await d.body.cancel().catch(() => {}),
        Error(
          `stream({ follow: false }) requires the server to report the ${EVE_STREAM_TAIL_INDEX_HEADER} header. The agent may be running an older eve version.`,
        )
      );
    if (u !== void 0 && o > u) {
      await d.body.cancel().catch(() => {});
      return;
    }
    let f = !1;
    try {
      for await (let e of readNdjsonStream(d.body))
        if (
          ((o += 1),
          (f = !0),
          (s = a.baseDelayMs),
          (c = 0),
          yield e,
          u !== void 0 && o > u)
        )
          return;
    } catch (e) {
      if (!isStreamDisconnectError(e)) throw e;
    }
    if (
      e.signal?.aborted ||
      e.startIndex < 0 ||
      a.maxAttempts === 0 ||
      (e.keepAlive !== !0 && !f && !l && (c += 1) >= a.maxAttempts) ||
      ((l = !1), await sleep(s, e.signal), e.signal?.aborted)
    )
      return;
    s = Math.min(s * 2, a.maxDelayMs);
  }
}
async function openStreamBody(t) {
  let r = t.retryPolicy ?? DEFAULT_STREAM_RECONNECT_POLICY,
    s = r.streamOpenReconnectPolicy,
    c,
    l,
    u,
    d = s.baseDelayMs,
    f = {};
  (t.startIndex !== 0 && (f.startIndex = String(t.startIndex)),
    t.requestTailIndex === !0 && (f.includeTailIndex = `1`));
  for (let o = 0; o < s.maxAttempts; o += 1) {
    let p = createClientUrl(
        t.host,
        createEveSessionStreamRoutePath(t.sessionId),
        Object.keys(f).length > 0 ? f : void 0,
      ),
      m = await t.resolveHeaders(),
      h;
    try {
      h = await fetch(p, {
        cache: `no-store`,
        headers: m,
        redirect: t.redirect,
        signal: t.signal ?? null,
      });
    } catch (e) {
      if (
        t.signal?.aborted ||
        !isStreamDisconnectError(e) ||
        o === s.maxAttempts - 1
      )
        throw e;
      (await sleep(d, t.signal), (d = Math.min(d * 2, s.maxDelayMs)));
      continue;
    }
    if (h.ok) {
      if (!h.body)
        throw new ClientError(h.status, `Response body is null.`, h.headers);
      return { body: h.body, tailIndex: parseTailIndexHeader(h.headers) };
    }
    if (
      ((c = h.status),
      (l = await h.text()),
      (u = h.headers),
      !r.retryableErrorStatuses.has(h.status))
    )
      throw new ClientError(h.status, l, h.headers);
    o < s.maxAttempts - 1 &&
      (await sleep(d, t.signal), (d = Math.min(d * 2, s.maxDelayMs)));
  }
  throw new ClientError(c ?? 0, l ?? `Failed to open message stream.`, u);
}
function parseTailIndexHeader(e) {
  let n = e.get(EVE_STREAM_TAIL_INDEX_HEADER);
  if (n === null || !/^-?\d+$/.test(n)) return;
  let r = Number(n);
  return Number.isSafeInteger(r) ? r : void 0;
}
async function sleep(e, t) {
  t?.aborted ||
    (await new Promise((n) => {
      let onAbort = () => {
          (clearTimeout(r), n());
        },
        r = setTimeout(() => {
          (t?.removeEventListener(`abort`, onAbort), n());
        }, e);
      t?.addEventListener(`abort`, onAbort, { once: !0 });
    }));
}
export { followStreamIterable, openStreamBody };
