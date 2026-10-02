const SESSION_WINDOW_TURN_LIMIT = 200;
var InMemoryAgentTraceStateStore = class {
  #e = new Map();
  #t = new Map();
  #n = new Map();
  deleteAction(e) {
    this.#e.delete(e);
  }
  deleteActions(e, t) {
    for (let [n, r] of this.#e)
      r.sessionId === e &&
        (t === void 0 || r.turnId === t) &&
        this.#e.delete(n);
  }
  deleteSession(e) {
    this.#t.delete(e);
  }
  deleteTurn(e, t) {
    this.#n.delete(turnKey(e, t));
  }
  findAction(e, t) {
    return [...this.#e.values()].find(
      (n) => n.sessionId === e && n.callId === t,
    );
  }
  getAction(e) {
    return this.#e.get(e);
  }
  getSession(e) {
    return this.#t.get(e);
  }
  getTurn(e, t) {
    return this.#n.get(turnKey(e, t));
  }
  setAction(e, t) {
    this.#e.set(e, t);
  }
  setSession(e, t) {
    this.#t.set(e, t);
  }
  setTurn(e, t, n) {
    this.#n.set(turnKey(e, t), n);
  }
};
function turnKey(e, t) {
  return `${e}:${t}`;
}
export { InMemoryAgentTraceStateStore, SESSION_WINDOW_TURN_LIMIT, turnKey };
