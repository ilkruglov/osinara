var SkippedSignal = class extends Error {
    key;
    constructor(e) {
      (super(`Skipped: ${e}`), (this.name = `SkippedSignal`), (this.key = e));
    }
  },
  InteractionRequired = class extends Error {
    question;
    constructor(e) {
      (super(`Interaction required for "${e.key}": ${e.message}`),
        (this.name = `InteractionRequired`),
        (this.question = e));
    }
  },
  InvalidAnswerError = class extends Error {
    question;
    constructor(e, t) {
      (super(t), (this.name = `InvalidAnswerError`), (this.question = e));
    }
    get key() {
      return this.question.key;
    }
  };
export { InteractionRequired, InvalidAnswerError, SkippedSignal };
