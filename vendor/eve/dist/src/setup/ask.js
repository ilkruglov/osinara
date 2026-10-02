import {
  optionById,
  optionByValue,
  requiredOptionId,
} from "./question-options.js";
import { renderEditableQuestion } from "./ask-editable.js";
import {
  InteractionRequired,
  InvalidAnswerError,
  SkippedSignal,
} from "./ask-signals.js";
import { SetupPrerequisiteRequired } from "./integrations/shared/prerequisite.js";
const select = (e) => ({ ...e, kind: `select` }),
  confirm = (e) => ({ ...e, kind: `confirm` });
function text(e) {
  return { ...e, kind: `text` };
}
function announce(e, t, n, r) {
  return (e?.onResolved?.({ key: t, value: n, source: r }), n);
}
function coerceAnswer(t, n) {
  if (t.kind === `select`) {
    let r = String(n),
      i = optionById(t, r);
    if (!i) {
      let e = t.options.map((e) => e.id).join(`, `);
      throw new InvalidAnswerError(
        t,
        `Invalid answer for "${t.key}": ${r}. Expected one of: ${e}.`,
      );
    }
    return i.value;
  }
  if (t.kind === `confirm`) {
    let e = typeof n == `boolean` ? n : n === `true` || (n !== `false` && null);
    if (e === null)
      throw new InvalidAnswerError(
        t,
        `Invalid answer for "${t.key}": expected a boolean.`,
      );
    return e;
  }
  let r = String(n),
    i = t.validate?.(r);
  if (i) throw new InvalidAnswerError(t, i);
  return r;
}
function coerceManyAnswer(t, n) {
  if (!Array.isArray(n))
    throw new InvalidAnswerError(
      t,
      `Invalid answer for "${t.key}": expected an array of option ids.`,
    );
  let r = [];
  for (let i of n) {
    let n = String(i),
      o = optionById(t, n);
    if (!o) {
      let e = t.options.map((e) => e.id).join(`, `);
      throw new InvalidAnswerError(
        t,
        `Invalid answer for "${t.key}": ${n}. Expected one of: ${e}.`,
      );
    }
    if (o.disabled) {
      let e = o.disabledReason === void 0 ? `` : ` (${o.disabledReason})`;
      throw new InvalidAnswerError(
        t,
        `Invalid answer for "${t.key}": ${n} is unavailable${e}.`,
      );
    }
    r.includes(o.value) || r.push(o.value);
  }
  for (let e of t.options)
    e.locked === !0 && !r.includes(e.value) && r.push(e.value);
  return r;
}
async function renderQuestion(e, t) {
  if (t.kind === `select`) {
    let r = t.detected ?? t.recommended;
    return coerceAnswer(
      t,
      await e.select({
        message: t.message,
        options: t.options.map((e) => ({
          value: e.id,
          label: e.label,
          hint: e.hint,
          featured: e.featured,
        })),
        initialValue:
          r === void 0
            ? void 0
            : requiredOptionId(
                t,
                r,
                t.detected === void 0 ? `recommendation` : `detected value`,
              ),
        search: t.search,
        placeholder: t.placeholder,
      }),
    );
  }
  if (t.kind === `confirm`) {
    let n = t.detected ?? t.recommended;
    return coerceAnswer(
      t,
      (await e.select({
        message: t.message,
        options: [
          { value: `yes`, label: `Yes` },
          { value: `no`, label: `No` },
        ],
        initialValue: n === void 0 ? void 0 : n ? `yes` : `no`,
      })) === `yes`,
    );
  }
  let r = t.validate,
    i = r === void 0 ? void 0 : (e) => r(e) ?? void 0,
    a = t.detected ?? t.recommended;
  return coerceAnswer(
    t,
    t.sensitive
      ? await e.password({ message: t.message, validate: i })
      : await e.text({
          message: t.message,
          placeholder: t.placeholder,
          defaultValue: a === void 0 ? void 0 : String(a),
          validate: i,
        }),
  );
}
async function renderManyQuestion(t, r) {
  let i = r.detected ?? r.recommended;
  return (
    await t.select({
      multiple: !0,
      message: r.message,
      options: r.options.map((e) => ({
        value: e.id,
        label: e.label,
        hint: e.hint,
        featured: e.featured,
        disabled: e.disabled,
        disabledReason: e.disabledReason,
        locked: e.locked,
        lockedReason: e.lockedReason,
      })),
      initialValues:
        i === void 0
          ? void 0
          : i.map((e) =>
              requiredOptionId(
                r,
                e,
                r.detected === void 0 ? `recommendation` : `detected value`,
              ),
            ),
      required: r.requireSelection,
      search: r.search,
      placeholder: r.placeholder,
    })
  ).map((t) => {
    let n = optionById(r, t);
    if (!n)
      throw new InvalidAnswerError(
        r,
        `Invalid answer for "${r.key}": ${t} is not an option id.`,
      );
    return n.value;
  });
}
function interactiveAsker(e, t) {
  return {
    async ask(n) {
      let r = await renderQuestion(e, n);
      return n.internal ? r : announce(t, n.key, r, `asked`);
    },
    async askEditable(n) {
      let i = await renderEditableQuestion(e, n);
      return (
        announce(t, n.key, i.value, `asked`),
        i.text !== void 0 && announce(t, n.editable.key, i.text, `asked`),
        i
      );
    },
    async askMany(n) {
      let r = await renderManyQuestion(e, n);
      return n.internal ? r : announce(t, n.key, r, `asked`);
    },
  };
}
function headlessAsker(e) {
  function refuse(t) {
    throw t.required
      ? new InteractionRequired(t)
      : (announce(e, t.key, void 0, `skipped`), new SkippedSignal(t.key));
  }
  return {
    async ask(e) {
      return refuse(e);
    },
    async askEditable(e) {
      return refuse(e);
    },
    async askMany(e) {
      return refuse(e);
    },
  };
}
function withAnswers(e, n) {
  return (r) => ({
    async ask(t) {
      if (t.key in e) {
        let r = coerceAnswer(t, e[t.key]);
        return announce(n, t.key, r, `answer`);
      }
      if (t.kind === `text` && t.sensitive === !0) {
        let e = process.env[t.environment];
        if (e !== void 0) return coerceAnswer(t, e);
        try {
          return await r.ask(t);
        } catch (e) {
          throw e instanceof InteractionRequired
            ? new SetupPrerequisiteRequired({
                kind: `environment`,
                code: t.key,
                message: `Set ${t.environment}, then retry setup.`,
                variable: t.environment,
                sensitive: !0,
              })
            : e;
        }
      }
      return r.ask(t);
    },
    async askEditable(i) {
      if (!(i.key in e)) return r.askEditable(i);
      let o = coerceAnswer(
        select({ key: i.key, message: i.message, options: i.options }),
        e[i.key],
      );
      if ((announce(n, i.key, o, `answer`), o !== i.editable.value))
        return { value: o };
      if (!(i.editable.key in e))
        return {
          value: o,
          text: (
            await r.ask(
              text({
                key: i.editable.key,
                message: optionByValue(i, o)?.label ?? i.message,
                recommended: i.editable.recommended,
                required: i.required,
                validate: i.editable.validate,
              }),
            )
          ).trim(),
        };
      let s = String(e[i.editable.key]),
        c = i.editable.validate?.(s);
      if (c)
        throw new InvalidAnswerError(
          text({
            key: i.editable.key,
            message: i.editable.label,
            required: i.required,
          }),
          c,
        );
      let l = s.trim();
      return (announce(n, i.editable.key, l, `answer`), { value: o, text: l });
    },
    async askMany(t) {
      if (t.key in e) {
        let r = coerceManyAnswer(t, e[t.key]);
        return announce(n, t.key, r, `answer`);
      }
      return r.askMany(t);
    },
  });
}
function withRequired(e) {
  return (t) => ({
    async ask(n) {
      return !n.required && e.includes(n.key)
        ? t.ask({ ...n, required: !0 })
        : t.ask(n);
    },
    async askEditable(n) {
      return t.askEditable(
        !n.required && e.includes(n.key) ? { ...n, required: !0 } : n,
      );
    },
    async askMany(n) {
      return !n.required && e.includes(n.key)
        ? t.askMany({ ...n, required: !0 })
        : t.askMany(n);
    },
  });
}
function withPolicy(e, t) {
  return (r) => ({
    async ask(i) {
      if (e === `assume`) {
        if (i.detected !== void 0)
          return (
            i.kind === `select` &&
              requiredOptionId(i, i.detected, `detected value`),
            announce(t, i.key, i.detected, `detected`)
          );
        if (i.recommended !== void 0)
          return (
            i.kind === `select` &&
              requiredOptionId(i, i.recommended, `recommendation`),
            announce(t, i.key, i.recommended, `assumed`)
          );
        if (!i.required)
          throw (
            announce(t, i.key, void 0, `skipped`),
            new SkippedSignal(i.key)
          );
        return r.ask(i);
      }
      return i.detected !== void 0 &&
        (await r.ask(
          confirm({
            key: i.key,
            message: `Use the detected value for "${i.key}"?`,
            internal: !0,
          }),
        ))
        ? announce(t, i.key, i.detected, `detected`)
        : r.ask(i);
    },
    async askEditable(i) {
      if (e !== `assume` || i.recommended === void 0) return r.askEditable(i);
      (requiredOptionId(i, i.editable.value, `configured editable value`),
        requiredOptionId(i, i.recommended, `recommendation`));
      let a =
        i.recommended === i.editable.value
          ? { value: i.recommended, text: i.editable.recommended }
          : { value: i.recommended };
      return (
        announce(t, i.key, a.value, `assumed`),
        a.text !== void 0 && announce(t, i.editable.key, a.text, `assumed`),
        a
      );
    },
    async askMany(i) {
      if (e === `assume`) {
        if (i.detected !== void 0) {
          for (let e of i.detected) requiredOptionId(i, e, `detected value`);
          return announce(t, i.key, [...i.detected], `detected`);
        }
        if (i.recommended !== void 0) {
          for (let e of i.recommended) requiredOptionId(i, e, `recommendation`);
          return announce(t, i.key, [...i.recommended], `assumed`);
        }
        if (!i.required)
          throw (
            announce(t, i.key, void 0, `skipped`),
            new SkippedSignal(i.key)
          );
        return r.askMany(i);
      }
      return i.detected !== void 0 &&
        (await r.ask(
          confirm({
            key: i.key,
            message: `Use the detected value for "${i.key}"?`,
            internal: !0,
          }),
        ))
        ? announce(t, i.key, [...i.detected], `detected`)
        : r.askMany(i);
    },
  });
}
export {
  InteractionRequired,
  InvalidAnswerError,
  SkippedSignal,
  confirm,
  headlessAsker,
  interactiveAsker,
  select,
  text,
  withAnswers,
  withPolicy,
  withRequired,
};
