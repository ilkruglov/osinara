import { isCurrentTurnBoundaryEvent } from "#protocol/message.js";
import { summarizeTurnEvents } from "#client/session-utils.js";
import { extractCompletedResult } from "#client/output-schema.js";
var MessageResponse = class {
  sessionId;
  #e;
  #t;
  #n = !1;
  #r;
  #i = !1;
  #a = Promise.withResolvers();
  constructor(e) {
    ((this.#e = e.cancelTurn),
      (this.sessionId = e.sessionId),
      (this.#r = e.createStream));
  }
  cancel() {
    if (this.#i) return Promise.resolve({ status: `no_active_turn` });
    if (this.#t !== void 0) return this.#t;
    let e = this.#a.promise.then((e) =>
      e === void 0 ? { status: `no_active_turn` } : this.#e(e),
    );
    return (
      (this.#t = e),
      e.catch(() => {
        !this.#i && this.#t === e && (this.#t = void 0);
      }),
      e
    );
  }
  async result() {
    let e = [];
    for await (let t of this) e.push(t);
    let n = summarizeTurnEvents(e);
    return {
      data: extractCompletedResult(e),
      events: e,
      inputRequests: n.inputRequests,
      message: n.message,
      sessionId: this.sessionId,
      status: n.status,
    };
  }
  [Symbol.asyncIterator]() {
    if (this.#n) throw Error(`MessageResponse has already been consumed.`);
    return ((this.#n = !0), this.#o());
  }
  async *#o() {
    try {
      for await (let t of this.#r())
        (t.type === `turn.started`
          ? this.#a.resolve(t.data.turnId)
          : isCurrentTurnBoundaryEvent(t) &&
            ((this.#i = !0), this.#a.resolve(void 0)),
          yield t);
    } finally {
      this.#a.resolve(void 0);
    }
  }
};
export { MessageResponse };
