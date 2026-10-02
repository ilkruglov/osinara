import { SessionDynamicModelReferenceKey } from "#context/keys.js";
function preserveSerializedSessionDynamicModelSelection(e, t) {
  let n = t[SessionDynamicModelReferenceKey.name];
  return n === void 0 ? e : { ...e, [SessionDynamicModelReferenceKey.name]: n };
}
export { preserveSerializedSessionDynamicModelSelection };
