import { isObject } from "#shared/guards.js";
import { decodeJwt } from "#compiled/jose/index.js";
function readCodexJwtExpirationMs(e) {
  let t = parseCodexJwtClaims(e);
  if (!(t === void 0 || typeof t.exp != `number`)) return t.exp * 1e3;
}
function extractCodexAccountIdFromToken(t) {
  let n = parseCodexJwtClaims(t);
  if (n === void 0) return;
  let r = n[`https://api.openai.com/auth`],
    i = n.organizations;
  return (
    readNonEmptyString$1(n.chatgpt_account_id) ??
    readNonEmptyString$1(isObject(r) ? r.chatgpt_account_id : void 0) ??
    readNonEmptyString$1(Array.isArray(i) && isObject(i[0]) ? i[0].id : void 0)
  );
}
function extractCodexAccountLabelFromToken(t) {
  let n = parseCodexJwtClaims(t);
  if (n === void 0) return;
  let r = n[`https://api.openai.com/auth`],
    i = readEmail(n.email) ?? readEmail(isObject(r) ? r.email : void 0);
  if (i !== void 0) return i;
  let a = readNonEmptyString$1(n.sub);
  return a === void 0 ? void 0 : readEmail(a.split(`|`).at(-1));
}
function readEmail(e) {
  let t = readNonEmptyString$1(e);
  return t !== void 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(t) ? t : void 0;
}
function readNonEmptyString$1(e) {
  return typeof e == `string` && e.trim() !== `` ? e : void 0;
}
function parseCodexJwtClaims(e) {
  if (e !== void 0)
    try {
      return decodeJwt(e);
    } catch {
      return;
    }
}
export {
  extractCodexAccountIdFromToken,
  extractCodexAccountLabelFromToken,
  readCodexJwtExpirationMs,
};
