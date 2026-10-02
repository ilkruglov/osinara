import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  isCurrentTurnBoundaryEvent,
  isTurnFailureEvent,
} from "#protocol/message.js";
import { summarizeTurnEvents } from "#client/session-utils.js";
import { createTextWithFileContent } from "#client/file-parts.js";
import { extractCompletedResult } from "#client/output-schema.js";
import {
  inputRequestMatches,
  matchesValue,
  toolCallMatches,
} from "#evals/match.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import {
  createOutputAssertions,
  createScopedAssertions,
} from "#evals/assertions/scoped.js";
import { EvalRequirementFailed } from "#evals/control-flow.js";
import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
var EveEvalTurnFailedError = class extends Error {
    event;
    turn;
    constructor(e) {
      let t = e.events.find(isTurnFailureEvent),
        n =
          t === void 0
            ? `turn ended with status "${e.status}"`
            : `${t.type}: ${t.data.code} ${t.data.message}`.trim();
      (super(`Eval turn failed: ${n}`),
        (this.name = `EveEvalTurnFailedError`),
        (this.event = t),
        (this.turn = e));
    }
  },
  EvalSessionDriver = class {
    #e;
    #t;
    #n;
    #r;
    #i = [];
    #a;
    #o;
    #s = [];
    #c = new Set();
    #l;
    #u = !1;
    #d = [];
    constructor(e) {
      ((this.#e = e.client),
        (this.#r = e.collector),
        (this.#o = e.onSessionStart),
        (this.#a = e.primary),
        (this.#t = e.session),
        (this.#n = e.signal),
        Object.assign(
          this,
          createScopedAssertions(this.#r, {
            timing: `snapshot`,
            select: () => this.#g(),
          }),
          createOutputAssertions(this.#r, {
            timing: `snapshot`,
            select: () => this.#g(),
          }),
        ));
    }
    get events() {
      return this.#i;
    }
    get lastTurn() {
      return this.#l;
    }
    get pendingInputRequests() {
      return this.#d;
    }
    get sessionId() {
      return this.#t?.state.sessionId ?? this.#l?.sessionId;
    }
    get state() {
      return this.#t?.state;
    }
    async cancel() {
      if (this.#t === void 0) throw Error(`Eval session has not started.`);
      return await this.#t.cancel();
    }
    requireInputRequest(e = {}) {
      this.#d.length === 0 &&
        this.#_(
          `requireInputRequest`,
          `expected one pending input request, but the last turn did not park`,
        );
      let t = this.#d.filter((t) => inputRequestMatches(t, e));
      return (
        (this.#d.length !== 1 || t.length !== 1) &&
          this.#_(
            `requireInputRequest`,
            `expected exactly one pending input request matching ${formatInputRequestFilter(e)}, found ${t.length} match(es) across ${this.#d.length} pending request(s)`,
          ),
        this.#r.recordOutcome({
          name: `requireInputRequest`,
          outcome: { score: 1 },
        }),
        t[0]
      );
    }
    async respond(e, t = {}) {
      if (e.length === 0)
        throw Error(`respond() requires at least one input response.`);
      return await (await this.#f({ ...t, inputResponses: e })).result();
    }
    async startRespond(e, t = {}) {
      if (e.length === 0)
        throw Error(`startRespond() requires input responses.`);
      return await this.#f({ ...t, inputResponses: e });
    }
    async respondAll(e) {
      let t = this.#d;
      if (t.length === 0)
        throw Error(
          `respondAll() requires at least one pending input request.`,
        );
      for (let n of t) assertRequestHasOption(n, e);
      return await this.respond(
        t.map((t) => ({ optionId: e, requestId: t.requestId })),
      );
    }
    async send(e, t = {}) {
      return await (
        await this.#f({ turnPolicy: `queue`, ...t, message: e })
      ).result();
    }
    async start(e, t = {}) {
      return await this.#f({ turnPolicy: `queue`, ...t, message: e });
    }
    async #f(e) {
      let t = attachSignal(e, this.#n),
        n;
      if (this.#t === void 0) {
        if (t.message === void 0) throw Error(`Eval session has not started.`);
        let e = await this.#e.sessions.create({ ...t, message: t.message });
        ((this.#t = e.session), (n = e.response));
      } else {
        let { inputResponses: e, message: r, ...i } = t;
        n =
          e === void 0 ? await this.#t.send(r, i) : await this.#t.respond(e, i);
      }
      return new EvalLiveTurn({
        events: n,
        observe: (e) => this.#p(n.sessionId, e),
        record: (e) => this.#h(n.sessionId, e),
        session: this,
        sessionId: n.sessionId,
      });
    }
    async sendFile(n, r, i) {
      let a = createTextWithFileContent({
        bytes: await readFile(r),
        filename: basename(r),
        mediaType: i ?? inferMediaType(r),
        text: n,
      });
      return await this.send(a);
    }
    async readTurn(e) {
      let t = this.sessionId;
      return await this.watchTurn(e, requireSessionId(t)).result();
    }
    watchTurn(e, t = requireSessionId(this.sessionId)) {
      if (this.#t === void 0) throw Error(`Eval session has not started.`);
      return new EvalLiveTurn({
        events: this.#t.stream({ signal: this.#n, startIndex: e?.startIndex }),
        observe: (e) => this.#p(t, e),
        record: (e) => this.#h(t, e),
        session: this,
        sessionId: t,
      });
    }
    snapshot() {
      let e = this.sessionId;
      return {
        derived: deriveRunFacts(this.#i, { sessionId: e }),
        events: [...this.#i],
        primary: this.#a,
        sessionId: e,
        state: this.#t?.state,
        traceContexts: [...this.#s],
      };
    }
    #p(e, t) {
      if (t.type !== `session.started` && t.type !== `turn.started`) return;
      let n = t.data.trace;
      if (n === void 0) return;
      let r = `${n.traceId}:${n.spanId}`;
      this.#c.has(r) ||
        (this.#c.add(r),
        this.#s.push(n),
        !this.#u &&
          ((this.#u = !0),
          this.#o?.({
            primary: this.#a,
            sessionId: e,
            startedAt: t.meta.at,
            traceContext: n,
          })));
    }
    #m(e) {
      (this.#i.push(...e.events),
        (this.#d = e.status === `waiting` ? e.inputRequests : []));
      let t = deriveRunFacts(e.events, { sessionId: e.sessionId }),
        n = new EvalTurn({
          collector: this.#r,
          data: e.data,
          derived: t,
          events: e.events,
          inputRequests: e.inputRequests,
          message: e.message,
          sessionId: e.sessionId,
          status: e.status,
          toolCalls: t.toolCalls,
        });
      return ((this.#l = n), n);
    }
    #h(e, t) {
      let n = summarizeTurnEvents(t);
      return this.#m({
        data: extractCompletedResult(t),
        events: t,
        inputRequests: n.inputRequests,
        message: n.message,
        sessionId: e,
        status: n.status,
      });
    }
    #g() {
      let e = this.sessionId;
      return {
        derived: deriveRunFacts(this.#i, { sessionId: e }),
        events: [...this.#i],
        output: outputOf(this.#l),
        status: this.#l?.status ?? `completed`,
      };
    }
    #_(e, t) {
      throw (
        this.#r.recordOutcome({ name: e, outcome: { score: 0, message: t } }),
        new EvalRequirementFailed()
      );
    }
  },
  EvalLiveTurn = class {
    session;
    sessionId;
    #e;
    #t = [];
    #n = new Set();
    #r;
    constructor(e) {
      ((this.session = e.session),
        (this.sessionId = e.sessionId),
        (this.#e = this.#i(e.events, e.observe, e.record)),
        this.#e.catch(() => {}));
    }
    get events() {
      return this.#t;
    }
    async cancel() {
      return await this.session.cancel();
    }
    async result() {
      return await this.#e;
    }
    async waitForEvent(e, t) {
      let matches = (n) =>
          n.type === e &&
          (t?.data === void 0 ||
            matchesValue(t.data, `data` in n ? n.data : void 0)),
        n = this.#t.find(matches);
      if (n !== void 0) return n;
      if (this.#r !== void 0) throw this.#r;
      return await new Promise((e, t) => {
        let n = { matches, reject: t, resolve: (t) => e(t) };
        this.#n.add(n);
      });
    }
    async #i(e, t, n) {
      try {
        let a = !1;
        for await (let n of e)
          if (
            (this.#t.push(n),
            t(n),
            this.#a(n),
            isTurnFailureEvent(n) &&
              this.#o(
                Error(
                  `Session ${this.sessionId} failed before the expected event (${n.type}).`,
                ),
              ),
            isCurrentTurnBoundaryEvent(n))
          ) {
            ((a = !0),
              this.#o(
                Error(
                  `Session ${this.sessionId} reached ${n.type} before the expected event.`,
                ),
              ));
            break;
          }
        if (!a)
          throw Error(
            `Stream for session "${this.sessionId}" closed before a turn boundary.`,
          );
        return n(this.#t);
      } catch (e) {
        let t = e instanceof Error ? e : Error(String(e));
        throw (this.#o(t), e);
      }
    }
    #a(e) {
      for (let t of this.#n) t.matches(e) && (this.#n.delete(t), t.resolve(e));
    }
    #o(e) {
      if (this.#r === void 0) {
        this.#r = e;
        for (let t of this.#n) t.reject(e);
        this.#n.clear();
      }
    }
  },
  EvalTurn = class {
    data;
    events;
    inputRequests;
    message;
    sessionId;
    status;
    toolCalls;
    #e;
    #t;
    constructor(e) {
      ((this.data = e.data),
        (this.events = e.events),
        (this.inputRequests = e.inputRequests),
        (this.message = e.message),
        (this.sessionId = e.sessionId),
        (this.status = e.status),
        (this.toolCalls = e.toolCalls),
        (this.#e = e.collector),
        (this.#t = e.derived),
        Object.assign(
          this,
          createScopedAssertions(e.collector, {
            timing: `snapshot`,
            select: () => this.#n(),
          }),
          createOutputAssertions(e.collector, {
            timing: `snapshot`,
            select: () => this.#n(),
          }),
        ));
    }
    expectOk() {
      if (this.status !== `failed`) return this;
      throw new EveEvalTurnFailedError(this);
    }
    requireToolCall(e, t = {}) {
      let n = this.toolCalls.filter(
        (n) => n.name === e && toolCallMatches(n, t),
      );
      return (
        n.length !== 1 &&
          inputRequirementFailed(
            this.#e,
            `requireToolCall`,
            `expected exactly one matching "${e}" tool call in this turn, found ${n.length}; observed [${this.toolCalls.map((e) => e.name).join(`, `)}]`,
          ),
        this.#e.recordOutcome({
          name: `requireToolCall`,
          outcome: { score: 1 },
        }),
        n[0]
      );
    }
    #n() {
      return {
        derived: this.#t,
        events: this.events,
        output: outputOf(this),
        status: this.status,
      };
    }
  },
  EvalSessionManager = class {
    #e;
    #t;
    #n;
    #r;
    #i = [];
    #a;
    constructor(e) {
      ((this.#e = e.client),
        (this.#n = e.collector ?? new AssertionCollector()),
        (this.#r = e.onSessionStart),
        (this.#t = e.signal));
    }
    get primary() {
      return ((this.#a ??= this.#o(!0)), this.#a);
    }
    newSession() {
      return this.#o(!1);
    }
    async attachSession(e, t) {
      let n = this.#s(e, t);
      return (await n.readTurn(t), n);
    }
    watchTurn(e, t) {
      return this.#s(e, t).watchTurn(t, e);
    }
    snapshots() {
      return this.#i.map((e) => e.snapshot());
    }
    lastTurnSession() {
      return this.#a?.lastTurn === void 0
        ? this.#i.find((e) => e.lastTurn !== void 0)
        : this.#a;
    }
    hasActivity() {
      return this.#i.length > 0;
    }
    #o(e) {
      let t = new EvalSessionDriver({
        client: this.#e,
        collector: this.#n,
        onSessionStart: this.#r,
        primary: e,
        signal: this.#t,
      });
      return (this.#i.push(t), t);
    }
    #s(e, t) {
      let n = new EvalSessionDriver({
        client: this.#e,
        collector: this.#n,
        onSessionStart: this.#r,
        primary: !1,
        session: this.#e.sessions.attach(e, {
          streamIndex: t?.startIndex ?? 0,
        }),
        signal: this.#t,
      });
      return (this.#i.push(n), n);
    }
  };
function attachSignal(e, t) {
  return t === void 0 ? e : e.signal === void 0 ? { ...e, signal: t } : e;
}
function formatInputRequestFilter(e) {
  return JSON.stringify(e);
}
function inputRequirementFailed(e, t, n) {
  throw (
    e.recordOutcome({ name: t, outcome: { score: 0, message: n } }),
    new EvalRequirementFailed()
  );
}
function outputOf(e) {
  return e === void 0 ? null : e.data === void 0 ? (e.message ?? null) : e.data;
}
function requireSessionId(e) {
  if (e === void 0)
    throw Error(`Eval session produced a turn without a session id.`);
  return e;
}
function assertRequestHasOption(e, t) {
  if (e.options === void 0 || e.options.length === 0)
    throw Error(`Input request "${e.requestId}" has no selectable options.`);
  if (!e.options.some((e) => e.id === t))
    throw Error(`Input request "${e.requestId}" does not offer option "${t}".`);
}
function inferMediaType(e) {
  switch (extname(e).toLowerCase()) {
    case `.gif`:
      return `image/gif`;
    case `.jpg`:
    case `.jpeg`:
      return `image/jpeg`;
    case `.png`:
      return `image/png`;
    case `.webp`:
      return `image/webp`;
    default:
      return `application/octet-stream`;
  }
}
export { EvalSessionDriver, EvalSessionManager, EveEvalTurnFailedError };
