import { createHash } from "node:crypto";
import {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
} from "#internal/invocation/attributes.js";
function invocationInputRequestId(t, n) {
  return createHash(`sha256`)
    .update(JSON.stringify([t, n]), `utf8`)
    .digest(`hex`);
}
function invocationOwnerKey(t) {
  let n =
    t === null
      ? [`anonymous`]
      : [
          t.authenticator,
          t.issuer ?? ``,
          t.principalType,
          t.principalId,
          t.subject ?? ``,
        ];
  return createHash(`sha256`).update(JSON.stringify(n), `utf8`).digest(`hex`);
}
function buildInvocationAttributes(e) {
  return {
    [INVOCATION_OWNER_ATTRIBUTE]: e.ownerKey,
    [INVOCATION_TOKEN_ATTRIBUTE]: e.continuationToken,
  };
}
export {
  INVOCATION_OWNER_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
  buildInvocationAttributes,
  invocationInputRequestId,
  invocationOwnerKey,
};
