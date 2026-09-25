/**
 * Set-of-marks scripts for the browser tools: number the page, keep the numbering in the page.
 *
 * Exports:
 * - `markScript(epoch)`: finds the visible elements a person could act on, draws a numbered badge
 *   on each, stores them in the page registry and returns the list as JSON.
 * - `clearScript()`: removes the badges; the registry stays.
 * - `actScript(epoch, n, action)`: acts on element `n` of the registry of exactly this epoch.
 * - `SOM_REGISTRY`: the window property the three scripts share.
 *
 * Key constructs:
 * - The registry holds DOM nodes, not selectors. A number means one element for as long as the
 *   epoch lives; after any re-render the epoch of the next mark differs and old numbers are
 *   refused by `actScript`, so a stale number can never hit a neighbour.
 * - Selection is by what a person sees: form controls and ARIA roles always, `cursor:pointer`
 *   only with own text, nothing larger than 40% of the viewport, nothing outside it, and no
 *   ancestor of an already chosen element (smaller elements win).
 * - Script clicks (`el.click()`) do not care what covers the element: cookie banners and sticky
 *   headers, which stopped pointer clicks in browser_task, do not exist for them.
 */
export const SOM_REGISTRY = "__osinaraSom";

export type SomAction =
  | { kind: "click" }
  | { kind: "enter" }
  | { kind: "fill"; text: string }
  | { kind: "select"; option: string };

const MARK = String.raw`(() => {
  const REG = ${JSON.stringify(SOM_REGISTRY)};
  const epoch = __EPOCH__;
  const norm = (s) => (s || "").replace(/[^{}]*\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
  const vw = innerWidth, vh = innerHeight;
  document.querySelectorAll(".osinara-som").forEach((b) => b.remove());
  const ROLE_TAGS = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", LABEL: "label", SUMMARY: "button", IFRAME: "frame" };
  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", file: "file", range: "slider", date: "date", time: "time" };
  const roleOf = (el) => {
    const r = el.getAttribute("role"); if (r) return r.split(" ")[0];
    if (el.tagName === "INPUT") return INPUT_ROLES[(el.type || "text").toLowerCase()] || "textbox";
    return ROLE_TAGS[el.tagName] || (el.isContentEditable ? "textbox" : "generic");
  };
  const ownText = (el) => norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
  const textOf = (el) => norm(el.getAttribute("aria-label") || "") || norm(el.innerText || el.textContent || "")
    || norm(el.getAttribute("placeholder") || "") || norm(el.getAttribute("title") || "")
    || norm([...el.querySelectorAll("img[alt]")].map((i) => i.alt).join(" "))
    || (el.tagName === "IFRAME" ? norm(el.title) || hostOf(el.src) : "")
    || (el.tagName === "A" && el.href ? hrefText(el.href) : "")
    || norm(el.getAttribute("name") || el.id || "");
  const hostOf = (u) => { try { return new URL(u, location.href).hostname; } catch { return ""; } };
  // An id-like path tail says nothing; the host at least says where the link goes.
  const hrefText = (href) => { const tail = decodeURIComponent(href.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() || ""); if (/\.(jpe?g|png|gif|webp|svg|avif)$/i.test(tail)) return "изображение"; return /^[A-Za-z0-9_-]{16,}$/.test(tail) || !tail || /^https?:$/.test(tail) ? hostOf(href) : norm(tail); };
  const labelOf = (el) => { if (!el.id) return ""; const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); return l ? norm(l.innerText) : ""; };
  const stateOf = (el) => {
    const s = [];
    if (el.checked || el.getAttribute("aria-checked") === "true") s.push("checked");
    if (el.getAttribute("aria-selected") === "true" || el.selected) s.push("selected");
    if (el.getAttribute("aria-pressed") === "true") s.push("pressed");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    if (el.getAttribute("aria-expanded") === "true") s.push("expanded");
    if (el.required) s.push("required");
    return s;
  };
  const candidate = (el) => {
    const tag = el.tagName;
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|IFRAME)$/.test(tag)) return tag !== "INPUT" || el.type !== "hidden";
    if (tag === "LABEL" && el.control) return true;
    const r = el.getAttribute("role");
    if (r && /^(button|link|checkbox|radio|tab|option|menuitem|menuitemcheckbox|menuitemradio|switch|textbox|combobox|listbox|slider|treeitem)$/.test(r)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute("onclick") || el.tabIndex >= 0) return !!ownText(el) || el.tabIndex >= 0 && tag !== "DIV";
    return getComputedStyle(el).cursor === "pointer" && !!ownText(el);
  };
  const all = [];
  const walk = (root) => { for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) walk(el.shadowRoot); all.push(el); } };
  walk(document);
  const cands = [];
  for (const el of all) {
    if (!candidate(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    if (el.tagName !== "IFRAME" && r.width * r.height > vw * vh * 0.4) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
    cands.push([el, r]);
  }
  cands.sort((a, b) => a[1].width * a[1].height - b[1].width * b[1].height);
  const chosen = [];
  for (const [el, r] of cands) {
    if (chosen.some((c) => c[0].contains(el) || el.contains(c[0]))) continue;
    chosen.push([el, r]);
  }
  chosen.sort((a, b) => (a[1].top - b[1].top) || (a[1].left - b[1].left));
  const elements = []; const nodes = [];
  chosen.forEach(([el, r], i) => {
    const n = i + 1; nodes.push(el);
    const role = roleOf(el);
    const isField = /^(textbox|combobox|searchbox|spinbutton|date|time|file)$/.test(role);
    const text = (isField && (labelOf(el) || textOf(el))) || textOf(el);
    const value = isField && typeof el.value === "string" ? norm(el.value) : null;
    elements.push({ n, role, text: text.slice(0, 60), value: value === null ? null : value.slice(0, 60), state: stateOf(el) });
    const b = document.createElement("div"); b.className = "osinara-som"; b.textContent = String(n);
    b.style.cssText = "position:fixed;left:" + Math.max(0, r.left - 2) + "px;top:" + Math.max(0, r.top - 2) + "px;z-index:2147483647;background:#d00;color:#fff;font:bold 11px/13px monospace;padding:1px 3px;border-radius:3px;pointer-events:none;box-shadow:0 0 0 1px #fff;";
    document.body.appendChild(b);
  });
  window[REG] = { epoch, nodes };
  return JSON.stringify({ epoch, url: location.href, title: document.title, elements, textHash: TEXT_HASH });
})()`;

/** djb2 of the visible text: cheap enough to run after every action, stable across re-renders. */
const TEXT_HASH = String.raw`(() => { const t = (document.body && document.body.innerText || "").replace(/\s+/g, " "); let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return h; })()`;

const CLEAR = String.raw`(() => { document.querySelectorAll(".osinara-som").forEach((b) => b.remove()); return "OK"; })()`;

const ACT = String.raw`(() => {
  const REG = ${JSON.stringify(SOM_REGISTRY)};
  const reg = window[REG];
  if (!reg || reg.epoch !== __EPOCH__) return JSON.stringify({ ok: false, reason: "stale" });
  const el = reg.nodes[__N__ - 1];
  if (!el || !el.isConnected) return JSON.stringify({ ok: false, reason: "gone" });
  const action = __ACTION__;
  const fire = (t, type) => t.dispatchEvent(new Event(type, { bubbles: true }));
  const setNative = (t, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t), "value"); if (d && d.set) d.set.call(t, v); else t.value = v; };
  document.querySelectorAll(".osinara-som").forEach((b) => b.remove());
  el.scrollIntoView({ block: "center", inline: "nearest" });
  if (action.kind === "click") { (el.tagName === "LABEL" && el.control ? el.control : el).click(); return JSON.stringify({ ok: true }); }
  if (action.kind === "enter") { return el.tagName === "IFRAME" && el.src ? JSON.stringify({ ok: true, src: el.src }) : JSON.stringify({ ok: false, reason: "not a frame" }); }
  if (action.kind === "fill") {
    const t = el.tagName === "LABEL" && el.control ? el.control : el;
    if (t.isContentEditable) { t.focus(); t.textContent = action.text; fire(t, "input"); return JSON.stringify({ ok: true }); }
    if (!("value" in t)) return JSON.stringify({ ok: false, reason: "not a field" });
    t.focus(); setNative(t, ""); fire(t, "input"); setNative(t, action.text); fire(t, "input"); fire(t, "change"); t.blur();
    return JSON.stringify({ ok: true });
  }
  if (action.kind === "select") {
    if (el.tagName !== "SELECT") return JSON.stringify({ ok: false, reason: "not a select" });
    const want = action.option.trim().toLowerCase();
    const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.trim().toLowerCase() === want)
      || [...el.options].find((o) => o.text.trim().toLowerCase().includes(want));
    if (!opt) return JSON.stringify({ ok: false, reason: "no such option" });
    el.value = opt.value; fire(el, "input"); fire(el, "change"); return JSON.stringify({ ok: true });
  }
  return JSON.stringify({ ok: false, reason: "unknown action" });
})()`;

export function markScript(epoch: string): string {
  return MARK.replace("__EPOCH__", JSON.stringify(epoch)).replace("TEXT_HASH", TEXT_HASH);
}

export function textHashScript(): string {
  return TEXT_HASH;
}

export function clearScript(): string {
  return CLEAR;
}

export function actScript(epoch: string, n: number, action: SomAction): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("AGENT_BROWSER_SOM_INDEX_INVALID");
  return ACT.replace("__EPOCH__", JSON.stringify(epoch)).replace("__N__", String(n)).replace("__ACTION__", JSON.stringify(action));
}
