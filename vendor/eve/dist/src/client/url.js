function createClientUrl(e, t, n) {
  let r = t.indexOf(`?`),
    i = r === -1 ? t : t.slice(0, r),
    a = r === -1 ? `` : t.slice(r + 1),
    o = i.startsWith(`/`) ? i : `/${i}`;
  if (isAbsoluteUrl(e)) {
    let t = new URL(e);
    return (
      (t.pathname = `${trimTrailingSlash(t.pathname)}${o}`),
      mergeEmbeddedQuery(t.searchParams, a),
      mergeSearchParams(t.searchParams, n),
      (t.hash = ``),
      t.toString()
    );
  }
  let s = new URL(e, `http://eve.local`),
    c = trimTrailingSlash(s.pathname);
  return (
    mergeEmbeddedQuery(s.searchParams, a),
    mergeSearchParams(s.searchParams, n),
    `${c}${o}${formatSearch(s.searchParams)}`
  );
}
function mergeEmbeddedQuery(e, t) {
  if (t.length !== 0) for (let [n, r] of new URLSearchParams(t)) e.append(n, r);
}
function isAbsoluteUrl(e) {
  return /^[a-z][a-z\d+\-.]*:/i.test(e);
}
function trimTrailingSlash(e) {
  return e === `/` ? `` : e.endsWith(`/`) ? e.slice(0, -1) : e;
}
function mergeSearchParams(e, t) {
  if (t !== void 0) for (let [n, r] of Object.entries(t)) e.set(n, r);
}
function formatSearch(e) {
  let t = e.toString();
  return t.length === 0 ? `` : `?${t}`;
}
export { createClientUrl };
