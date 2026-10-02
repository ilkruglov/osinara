import { StringDecoder } from "node:string_decoder";
function resultSucceeded(e) {
  return e.termination.kind === `exit` && e.termination.code === 0;
}
function createPackageProcessStdoutCollector(t) {
  let n = t.maxCapturedBytes ?? 65536,
    r = new StringDecoder(`utf8`),
    i = ``,
    a = 0;
  function capture(e) {
    for (let t of e) {
      let e = Buffer.byteLength(t);
      if (a + e > n) return;
      ((i += t), (a += e));
    }
  }
  return {
    write(e) {
      capture(r.write(e));
    },
    end() {
      capture(r.end());
    },
    result(e) {
      return { command: t.command, termination: e, stdout: i };
    },
  };
}
export { createPackageProcessStdoutCollector, resultSucceeded };
