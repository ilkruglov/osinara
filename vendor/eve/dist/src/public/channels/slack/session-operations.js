function bindSlackSessionOperations(e) {
  let t = e.from(e.address),
    auth = (t) => (t === void 0 ? e.defaultAuth : t);
  return {
    async send(n, r = {}) {
      return await t.send(n, { ...r, auth: auth(r.auth), state: e.state });
    },
    async respond(e, n = {}) {
      return await t.respond(e, { ...n, auth: auth(n.auth) });
    },
    async cancel(e) {
      return await t.cancel(e);
    },
    async compact() {
      return await t.compact();
    },
    async clear() {
      return await t.clear();
    },
    async reset(e) {
      return await t.reset(e);
    },
    async resolveSession() {
      return await e.resolveSession(e.address);
    },
  };
}
export { bindSlackSessionOperations };
