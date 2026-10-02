import { EVE_TASK_INPUT_ROUTE_PATTERN } from "#protocol/routes.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { readTaskInputTargetToken } from "#execution/task-input-capability.js";
const NAME = `eve/v1/task-input/post`;
function getTaskInputResponseChannelDefinitions() {
  return [
    {
      fetch: handleTaskInputResponseRequest,
      logicalPath: `framework://channels/${NAME}`,
      method: `POST`,
      name: NAME,
      sourceId: `eve:framework:task-input-post`,
      sourceKind: `module`,
      urlPath: EVE_TASK_INPUT_ROUTE_PATTERN,
    },
  ];
}
function getTaskInputResponseChannelNames() {
  return new Set([NAME]);
}
async function handleTaskInputResponseRequest(e, r) {
  let i = r.params.token;
  if (typeof i != `string` || i.length === 0)
    return Response.json(
      { error: `Missing task input token.`, ok: !1 },
      { status: 400 },
    );
  let a = readTaskInputTargetToken(i);
  if (a === void 0)
    return Response.json(
      { error: `Invalid task input token.`, ok: !1 },
      { status: 403 },
    );
  let o;
  try {
    o = await e.json();
  } catch {
    return Response.json(
      { error: `Invalid JSON body.`, ok: !1 },
      { status: 400 },
    );
  }
  let s = readInputResponses(o);
  if (s === void 0 || s.length === 0)
    return Response.json(
      { error: `Expected a non-empty inputResponses array.`, ok: !1 },
      { status: 400 },
    );
  try {
    await resumeSessionInbox(a, {
      kind: `send`,
      payload: { inputResponses: s },
    });
  } catch {
    return Response.json(
      { error: `Task input target is not pending.`, ok: !1 },
      { status: 404 },
    );
  }
  return Response.json({ ok: !0 }, { status: 202 });
}
function readInputResponses(e) {
  if (typeof e != `object` || !e || Array.isArray(e)) return;
  let t = Reflect.get(e, `inputResponses`);
  if (!Array.isArray(t)) return;
  let n = [];
  for (let e of t) {
    if (typeof e != `object` || !e || Array.isArray(e)) return;
    let t = Reflect.get(e, `requestId`),
      r = Reflect.get(e, `optionId`),
      i = Reflect.get(e, `text`);
    if (
      typeof t != `string` ||
      (r !== void 0 && typeof r != `string`) ||
      (i !== void 0 && typeof i != `string`)
    )
      return;
    let a = { requestId: t };
    (typeof r == `string` && (a.optionId = r),
      typeof i == `string` && (a.text = i),
      n.push(a));
  }
  return n;
}
export {
  getTaskInputResponseChannelDefinitions,
  getTaskInputResponseChannelNames,
  handleTaskInputResponseRequest,
};
