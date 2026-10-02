import { resolvePackageCompiledFilePath } from "#internal/application/package.js";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { BaseEnvRunner } from "#compiled/env-runner/index.js";
var NodeDevelopmentRunner = class extends BaseEnvRunner {
  #e;
  #t = new Set();
  #n;
  #r;
  #i = !1;
  constructor(t) {
    let n = resolvePackageCompiledFilePath(
      `src/compiled/env-runner/node-worker.js`,
    );
    (super({
      data: { entry: t.entry, ...t.workerData },
      hooks: {
        onClose: (e, t) => {
          let n = [...this.#t];
          this.#t.clear();
          for (let e of n) e(t);
        },
      },
      name: t.name,
      workerEntry: n,
    }),
      this._initWithVirtualData(() => this.#a()));
  }
  onceClosed(e) {
    if (this.closed) {
      e(this.#e);
      return;
    }
    this.#t.add(e);
  }
  sendMessage(e) {
    if (this.#n === void 0)
      throw Error(`Development worker is not initialized.`);
    this.#n.postMessage(e);
  }
  async waitForReady(e) {
    try {
      await super.waitForReady(e);
    } catch (e) {
      throw this.#e === void 0
        ? e
        : Error(
            `Development worker failed before readiness: ${this.#e instanceof Error ? this.#e.message : String(this.#e)}`,
            { cause: this.#e },
          );
    }
  }
  _hasRuntime() {
    return this.#n !== void 0;
  }
  _runtimeType() {
    return `worker`;
  }
  async _closeRuntime() {
    let e = this.#n;
    if (e === void 0) return;
    let t = this.#r;
    ((this.#n = void 0), (this.#r = void 0));
    try {
      (this.#i || e.postMessage({ event: `shutdown` }),
        !this.#i &&
          t !== void 0 &&
          !(await waitForWorkerExit(t)) &&
          (await e.terminate()));
    } finally {
      e.removeAllListeners();
    }
  }
  _handleMessage(e) {
    (isWorkerInitializationError(e) && (this.#e = Error(e.error)),
      super._handleMessage(e));
  }
  #a() {
    if (!existsSync(this._workerEntry)) {
      this.close(
        `Development worker entry not found at "${this._workerEntry}".`,
      );
      return;
    }
    let e = new Worker(this._workerEntry, {
      env: process.env,
      workerData: { name: this._name, ...this._data },
    });
    ((this.#n = e), (this.#i = !1));
    let r;
    ((this.#r = new Promise((e) => {
      r = e;
    })),
      e.once(`error`, (e) => {
        ((this.#e = e), this.close(e));
      }),
      e.once(`exit`, (e) => {
        if (((this.#i = !0), r(), !this.closed)) {
          let t = Error(`Development worker exited with code ${String(e)}.`);
          ((this.#e ??= t), this.close(t));
        }
      }),
      e.on(`message`, (e) => this._handleMessage(e)));
  }
};
const createNodeDevelopmentRunner = (e) => new NodeDevelopmentRunner(e);
async function waitForWorkerExit(e) {
  let t;
  try {
    return await Promise.race([
      e.then(() => !0),
      new Promise((e) => {
        ((t = setTimeout(() => e(!1), 15e3)), t.unref());
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}
function isWorkerInitializationError(e) {
  if (typeof e != `object` || !e) return !1;
  let t = e;
  return t.event === `init-error` && typeof t.error == `string`;
}
export { createNodeDevelopmentRunner };
