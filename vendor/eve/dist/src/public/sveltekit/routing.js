function joinRoutePrefix(e, t) {
  return `${e.replace(/\/+$/, ``)}/${t.replace(/^\/+/, ``)}`;
}
function normalizeOrigin(e) {
  return new URL(e.trim()).origin;
}
export { joinRoutePrefix, normalizeOrigin };
