import { isObject } from "#shared/guards.js";
import { parseJsonValue } from "#shared/json.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
async function resolveProvidedArguments(r) {
  if (!isObject(r.args))
    throw Error(
      `Tool "${r.toolName}" in connection "${r.connection.connectionName}" expected object arguments.`,
    );
  let i = r.connection.toolCall?.providedArguments;
  if (i === void 0 || Object.keys(i).length === 0) return r.args;
  let a,
    getContext = () =>
      (a ??= { ...buildCallbackContext(), toolName: r.toolName }),
    o = {};
  for (let [e, n] of Object.entries(i)) {
    let i = typeof n == `function` ? await n(getContext()) : await n;
    try {
      o[e] = parseJsonValue(i);
    } catch {
      throw Error(
        `Connection "${r.connection.connectionName}" provided argument "${e}" must resolve to a JSON-serializable value.`,
      );
    }
  }
  return { ...r.args, ...o };
}
function omitProvidedArgumentsFromSchema(t, n) {
  if (n.length === 0) return t;
  let r = new Set(n),
    i = { ...t };
  return (
    isObject(t.properties) &&
      (i.properties = Object.fromEntries(
        Object.entries(t.properties).filter(([e]) => !r.has(e)),
      )),
    Array.isArray(t.required) &&
      (i.required = t.required.filter(
        (e) => typeof e != `string` || !r.has(e),
      )),
    i
  );
}
export { omitProvidedArgumentsFromSchema, resolveProvidedArguments };
