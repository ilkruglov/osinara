import { requiredOptionId } from "./question-options.js";
function wireOptions(e) {
  return e.options.map((e) => {
    let t = { id: e.id, label: e.label };
    return (
      e.hint !== void 0 && (t.hint = e.hint),
      e.disabled !== void 0 && (t.disabled = e.disabled),
      e.disabledReason !== void 0 && (t.disabledReason = e.disabledReason),
      e.locked !== void 0 && (t.locked = e.locked),
      e.lockedReason !== void 0 && (t.lockedReason = e.lockedReason),
      t
    );
  });
}
function sharedQuestion(e) {
  return { key: e.key, message: e.message, required: e.required === !0 };
}
function setupQuestionToWire(t) {
  let n = sharedQuestion(t);
  if (`editable` in t) {
    let r = t,
      i = requiredOptionId(r, r.editable.value, `configured editable value`),
      a = {
        ...n,
        kind: `editable-select`,
        options: wireOptions(r),
        editable: {
          key: r.editable.key,
          optionId: i,
          label: r.editable.label,
          recommended: r.editable.recommended,
        },
      };
    return (
      r.recommended !== void 0 &&
        (a.recommended = requiredOptionId(r, r.recommended, `recommendation`)),
      a
    );
  }
  if (!(`kind` in t)) {
    let r = t,
      i = { ...n, kind: `multi-select`, options: wireOptions(r) };
    return (
      r.recommended !== void 0 &&
        (i.recommended = r.recommended.map((t) =>
          requiredOptionId(r, t, `recommendation`),
        )),
      i
    );
  }
  let r = t;
  if (r.kind === `confirm`) {
    let e = { ...n, kind: `confirm` };
    return (r.recommended !== void 0 && (e.recommended = r.recommended), e);
  }
  if (r.kind === `text`) {
    if (r.sensitive === !0)
      return {
        ...n,
        kind: `environment`,
        variable: r.environment,
        sensitive: !0,
      };
    let e = { ...n, kind: `text`, sensitive: !1 };
    return (r.placeholder !== void 0 && (e.placeholder = r.placeholder), e);
  }
  let i = { ...n, kind: `select`, options: wireOptions(r) };
  return (
    r.recommended !== void 0 &&
      (i.recommended = requiredOptionId(r, r.recommended, `recommendation`)),
    i
  );
}
export { setupQuestionToWire };
