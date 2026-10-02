var AgentTraceSpanProcessor = class {
  #e;
  #t = new Set();
  #n = new Map();
  constructor(e) {
    this.#e = e;
  }
  async forceFlush() {
    await Promise.all(this.#e.map((e) => e.forceFlush()));
  }
  onStart(e, t) {
    if (!isSpanLike(e)) return;
    let n = e.attributes[`agent.session.id`];
    if (typeof n == `string`) {
      let t = e.attributes[`agent.root.session.id`],
        r = typeof t == `string` ? t : n,
        i = e.spanContext().traceId;
      this.#t.add(i);
      let a = this.#n.get(r) ?? new Set();
      (a.add(i), this.#n.set(r, a));
    }
    if (this.#r(e)) for (let n of this.#e) n.onStart(e, t);
  }
  onEnd(e) {
    if (!(!isSpanLike(e) || !this.#r(e))) for (let t of this.#e) t.onEnd(e);
  }
  activeTraceIds() {
    return this.#t;
  }
  releaseSession(e) {
    let t = this.#n.get(e);
    if (t === void 0) return !1;
    for (let e of t) this.#t.delete(e);
    return (this.#n.delete(e), !0);
  }
  async shutdown() {
    await Promise.all(this.#e.map((e) => e.shutdown()));
  }
  #r(e) {
    return (
      e.instrumentationScope?.name !== `workflow` &&
      this.#t.has(e.spanContext().traceId)
    );
  }
};
function isSpanLike(e) {
  return (
    typeof e == `object` &&
    !!e &&
    `attributes` in e &&
    `spanContext` in e &&
    typeof e.spanContext == `function`
  );
}
export { AgentTraceSpanProcessor };
