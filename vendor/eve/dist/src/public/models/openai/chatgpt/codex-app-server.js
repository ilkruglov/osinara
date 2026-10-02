import { spawn } from "node:child_process";
import { isObject } from "#shared/guards.js";
import { createInterface } from "node:readline";
var CodexAppServerClient = class {
    #e;
    #t;
    #n;
    #r;
    constructor(e = {}) {
      ((this.#e = e.command ?? `codex`),
        (this.#t = e.env),
        (this.#n = e.spawnProcess ?? spawnCodexAppServer));
    }
    async getAuthStatus(e) {
      let t = await this.#i();
      try {
        return await t.getAuthStatus(e);
      } catch (e) {
        throw (t.exited && (this.#r = void 0), e);
      }
    }
    restart() {
      let e = this.#r;
      ((this.#r = void 0), e?.then((e) => e.close()).catch(() => void 0));
    }
    #i() {
      return (
        this.#r === void 0 &&
          (this.#r = CodexAppServerConnection.start({
            command: this.#e,
            env: this.#t,
            spawnProcess: this.#n,
          }).catch((e) => {
            throw ((this.#r = void 0), e);
          })),
        this.#r
      );
    }
  },
  CodexAppServerConnection = class CodexAppServerConnection {
    #e;
    #t;
    #n = new Map();
    #r = 1;
    #i = !1;
    #a;
    constructor(e) {
      ((this.#e = e),
        e.unref(),
        unrefStream(e.stdin),
        unrefStream(e.stdout),
        unrefStream(e.stderr),
        e.stderr.resume(),
        (this.#t = createInterface({ input: e.stdout })),
        this.#t.on(`line`, (e) => this.#l(e)),
        e.once(`error`, (e) => this.#u(e)),
        e.once(`exit`, (e, t) => {
          let n = t === null ? `code ${e ?? `unknown`}` : `signal ${t}`;
          this.#u(Error(`Codex app-server exited with ${n}.`));
        }));
    }
    get exited() {
      return this.#i;
    }
    close() {
      (this.#e.kill(),
        this.#u(Error(`Codex app-server connection was restarted.`)));
    }
    static async start(e) {
      let t;
      try {
        t = e.spawnProcess(e.command, [`app-server`, `--stdio`], {
          env: e.env,
          stdio: [`pipe`, `pipe`, `pipe`],
        });
      } catch (e) {
        throw codexUnavailableError(e);
      }
      let n = new CodexAppServerConnection(t);
      try {
        return (
          await n.#o(`initialize`, {
            capabilities: null,
            clientInfo: { name: `eve`, title: `eve`, version: `0.35.0` },
          }),
          n.#s(`initialized`, {}),
          n
        );
      } catch (e) {
        throw (t.kill(), e);
      }
    }
    async getAuthStatus(e) {
      let n = await this.#o(`getAuthStatus`, {
        includeToken: !0,
        refreshToken: e.refreshToken,
      });
      if (!isObject(n))
        throw Error(
          `Codex app-server returned an invalid authentication response.`,
        );
      return {
        ...(typeof n.authMethod == `string` && { authMethod: n.authMethod }),
        ...(typeof n.authToken == `string` && { authToken: n.authToken }),
        ...(typeof n.requiresOpenaiAuth == `boolean` && {
          requiresOpenaiAuth: n.requiresOpenaiAuth,
        }),
      };
    }
    #o(e, t) {
      if (this.#i)
        return Promise.reject(
          this.#a ?? Error(`Codex app-server is not running.`),
        );
      let n = this.#r++,
        r = new Promise((e, t) => {
          this.#n.set(n, { reject: t, resolve: e });
        });
      return (this.#c({ id: n, method: e, params: t }), r);
    }
    #s(e, t) {
      this.#c({ method: e, params: t });
    }
    #c(e) {
      this.#e.stdin.write(`${JSON.stringify(e)}\n`);
    }
    #l(e) {
      let t;
      try {
        t = JSON.parse(e);
      } catch {
        return;
      }
      if (typeof t.id != `number`) return;
      let n = this.#n.get(t.id);
      if (n !== void 0) {
        if ((this.#n.delete(t.id), t.error !== void 0)) {
          n.reject(
            Error(
              t.error.message ??
                `Codex app-server request failed (${t.error.code}).`,
            ),
          );
          return;
        }
        n.resolve(t.result);
      }
    }
    #u(e) {
      if (!this.#i) {
        ((this.#i = !0), (this.#a = codexUnavailableError(e)), this.#t.close());
        for (let e of this.#n.values()) e.reject(this.#a);
        this.#n.clear();
      }
    }
  };
function spawnCodexAppServer(t, n, r) {
  return spawn(t, [...n], r);
}
function unrefStream(e) {
  `unref` in e && typeof e.unref == `function` && e.unref();
}
function codexUnavailableError(e) {
  if (e instanceof Error && `code` in e && e.code === `ENOENT`)
    return Error(
      "ChatGPT subscription authentication requires the Codex CLI. Install or upgrade `codex`, then run `codex login`.",
    );
  let t = e instanceof Error ? e.message : String(e);
  return Error(`Codex app-server is unavailable: ${t}`);
}
export { CodexAppServerClient };
