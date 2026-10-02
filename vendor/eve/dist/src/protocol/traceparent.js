const TRACEPARENT_PATTERN =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;
function formatTraceparent(e) {
  if (
    !(
      e === void 0 ||
      !validId(e.traceId, 32) ||
      !validId(e.spanId, 16) ||
      !Number.isInteger(e.traceFlags) ||
      e.traceFlags < 0 ||
      e.traceFlags > 255
    )
  )
    return `00-${e.traceId.toLowerCase()}-${e.spanId.toLowerCase()}-${e.traceFlags.toString(16).padStart(2, `0`)}`;
}
function parseTraceparent(t) {
  if (t === null) return;
  let n = TRACEPARENT_PATTERN.exec(t.trim());
  if (n === null) return;
  let r = n[1].toLowerCase(),
    i = n[2].toLowerCase();
  if (!(!validId(r, 32) || !validId(i, 16)))
    return {
      isRemote: !0,
      spanId: i,
      traceFlags: Number.parseInt(n[3], 16),
      traceId: r,
    };
}
function validId(e, t) {
  return e.length === t && /^[0-9a-f]+$/iu.test(e) && !/^0+$/u.test(e);
}
export { formatTraceparent, parseTraceparent };
