/**
 * Set-of-marks scripts for the browser tools: number the page, keep the numbering in the page.
 *
 * Exports:
 * - `markScript(epoch)`: finds the visible elements a person could act on, draws a numbered badge
 *   on each, stores them in the page registry and returns the list as JSON.
 * - `clearScript()`: removes the badges; the registry stays.
 * - `actScript(epoch, n, action)`: acts on element `n` of the registry of exactly this epoch.
 * - `stateHashScript()`: hash of role, text, value and state of the registry's elements as they
 *   are now, to compare with the hash the mark computed.
 * - `readTextScript()`: the visible text, including shadow roots, which `innerText` skips.
 * - `SOM_REGISTRY`: the window property the scripts share.
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

/** Reading helpers shared by the mark and the state hash, so both describe an element the same way. */
const HELPERS = String.raw`
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const SKIP_TEXT = /^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/;
  // Text of a subtree without its <style> and <script> bodies, which textContent would include.
  const plainText = (root) => { const parts = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement && SKIP_TEXT.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }); let n; while ((n = w.nextNode())) parts.push(n.textContent); return norm(parts.join(" ")); };
  const djb2 = (t) => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return h; };
  const ROLE_TAGS = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", LABEL: "label", SUMMARY: "button", IFRAME: "frame" };
  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", submit: "button", button: "button", reset: "button", image: "button", password: "password", search: "searchbox", file: "file", range: "slider", date: "date", time: "time" };
  const roleOf = (el) => {
    // A button that submits its form is "submit" whatever its label or ARIA role says: the gate
    // stops on the role, and role="button" on a submit button must not hide the submission.
    if (el.tagName === "INPUT" && /^(submit|image)$/.test((el.type || "text").toLowerCase()) && el.form) return "submit";
    if (el.tagName === "BUTTON" && el.form && (el.type || "submit").toLowerCase() === "submit") return "submit";
    const r = el.getAttribute("role"); if (r) return r.split(" ")[0];
    if (el.tagName === "INPUT") return INPUT_ROLES[(el.type || "text").toLowerCase()] || "textbox";
    return ROLE_TAGS[el.tagName] || (el.isContentEditable ? "textbox" : "generic");
  };
  const hostOf = (u) => { try { return new URL(u, location.href).hostname; } catch { return ""; } };
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const hrefText = (href) => { const tail = decode(href.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() || ""); if (/\.(jpe?g|png|gif|webp|svg|avif)$/i.test(tail)) return "изображение"; return /^[A-Za-z0-9_-]{16,}$/.test(tail) || !tail || /^https?:$/.test(tail) ? hostOf(href) : norm(tail); };
  const ownText = (el) => norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
  const textOf = (el) => norm(el.getAttribute("aria-label") || "")
    || (el.tagName === "INPUT" && /^(submit|button|reset|image)$/i.test(el.type) ? norm(el.value || el.alt || (el.type === "submit" ? "Отправить" : "")) : "")
    || norm(el.innerText || el.textContent || "")
    || (el.shadowRoot ? plainText(el.shadowRoot) : "")
    || norm(el.getAttribute("placeholder") || "") || norm(el.getAttribute("title") || "")
    || norm([...el.querySelectorAll("img[alt]")].map((i) => i.alt).join(" "))
    || (el.tagName === "IFRAME" ? norm(el.title) || hostOf(el.src) : "")
    || (el.tagName === "A" && el.href ? hrefText(el.href) : "")
    || norm(el.getAttribute("name") || el.id || "");
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
  const isField = (role) => /^(textbox|combobox|searchbox|spinbutton|date|time|file|password)$/.test(role);
  // A password never leaves the page: the model, the row and the hash see only that one is typed.
  const valueOf = (el, role) => {
    if (!isField(role) || typeof el.value !== "string") return null;
    if (String(el.type).toLowerCase() === "password") return el.value ? "••••" : "";
    return norm(el.value);
  };
  // A <label> is what its control is: a label over a hidden submit is a button to the gate.
  const full = (el) => {
    const target = el.tagName === "LABEL" && el.control ? el.control : el;
    const role = roleOf(target); const field = isField(role);
    return { role, text: (field && (labelOf(target) || textOf(target))) || textOf(el), value: valueOf(target, role), state: stateOf(target) };
  };
  const describe = (el) => { const d = full(el); return { role: d.role, text: d.text.slice(0, 60), value: d.value === null ? null : d.value.slice(0, 60), state: d.state }; };
  // Hashed in full: a changed tail of a long address must make the confirmation stale.
  const stateHashOf = (nodes) => djb2(nodes.map((el) => { const d = full(el); return d.role + "\u0002" + d.text + "\u0002" + (d.value || "") + "\u0002" + d.state.join(","); }).join("\u0001") + "\u0003" + fieldsStateOf());
  const visibleText = () => { const parts = [(document.body && document.body.innerText) || ""]; const walk = (root) => { for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { parts.push(plainText(el.shadowRoot)); walk(el.shadowRoot); } }; walk(document); return norm(parts.join(" ")); };
  // Every field of the page, on screen or not: the form a confirmation submits is the whole form.
  const allFields = () => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll("input,select,textarea")) { if (String(el.type).toLowerCase() !== "hidden") out.push(el); if (el.shadowRoot) walk(el.shadowRoot); } for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot); }; walk(document); return out; };
  const fieldsStateOf = () => allFields().map((el) => { const role = roleOf(el); return (el.name || el.id || "") + "\u0002" + (valueOf(el, role) || "") + "\u0002" + stateOf(el).join(","); }).join("\u0001");
`;

const MARK = String.raw`(() => {
  const REG = ${JSON.stringify(SOM_REGISTRY)};
  const epoch = __EPOCH__;
  __HELPERS__
  const vw = innerWidth, vh = innerHeight;
  document.querySelectorAll(".osinara-som").forEach((b) => b.remove());
  // The text is hashed before any badge exists, so an act's check sees the same text again.
  const textHash = djb2(visibleText());
  const candidate = (el) => {
    const tag = el.tagName;
    if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|IFRAME)$/.test(tag)) return tag !== "INPUT" || el.type !== "hidden";
    if (tag === "LABEL" && el.control) return true;
    const r = el.getAttribute("role");
    if (r && /^(button|link|checkbox|radio|tab|option|menuitem|menuitemcheckbox|menuitemradio|switch|textbox|combobox|listbox|slider|treeitem)$/.test(r)) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute("onclick") || el.tabIndex >= 0) return !!ownText(el) || el.tabIndex >= 0 && tag !== "DIV";
    // A custom element (yclients' y-core-chip time slots) keeps its text in its shadow root and its
    // click in a delegated listener: no cursor, role or tabindex says it is clickable. A short leaf
    // widget with its own text is offered anyway; a wrapper with element children is not.
    if (el.shadowRoot && tag.includes("-")) {
      if (getComputedStyle(el).cursor === "pointer" || el.tabIndex >= 0) return true;
      const t = textOf(el); return t.length > 0 && t.length <= 30 && !el.firstElementChild;
    }
    return getComputedStyle(el).cursor === "pointer" && !!ownText(el);
  };
  // Containment across shadow boundaries: a host contains what its shadow tree renders.
  const within = (outer, inner) => { for (let x = inner; x; x = x.parentNode || x.host) if (x === outer) return true; return false; };
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
  // A native control wins over anything inside it, an ARIA role over a pointer-styled child:
  // <button><span role="img">✓</span></button> is the button, whose role the gate reads. Within a
  // rank the smallest wins.
  const semantic = (el) => /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL|IFRAME)$/.test(el.tagName) ? 0 : el.hasAttribute("role") ? 1 : 2;
  cands.sort((a, b) => (semantic(a[0]) - semantic(b[0])) || (a[1].width * a[1].height - b[1].width * b[1].height));
  const chosen = [];
  for (const [el, r] of cands) {
    if (chosen.some((c) => within(c[0], el) || within(el, c[0]))) continue;
    chosen.push([el, r]);
  }
  // A label whose control has its own number would be the same field twice.
  const kept = chosen.filter(([el]) => !(el.tagName === "LABEL" && el.control && chosen.some(([c]) => c === el.control)));
  kept.sort((a, b) => (a[1].top - b[1].top) || (a[1].left - b[1].left));
  const elements = []; const nodes = [];
  kept.forEach(([el, r], i) => {
    const n = i + 1; nodes.push(el);
    elements.push({ n, ...describe(el) });
    const b = document.createElement("div"); b.className = "osinara-som"; b.textContent = String(n);
    b.style.cssText = "position:fixed;left:" + Math.max(0, r.left - 2) + "px;top:" + Math.max(0, r.top - 2) + "px;z-index:2147483647;background:#d00;color:#fff;font:bold 11px/13px monospace;padding:1px 3px;border-radius:3px;pointer-events:none;box-shadow:0 0 0 1px #fff;";
    document.body.appendChild(b);
  });
  window[REG] = { epoch, nodes };
  return JSON.stringify({ epoch, url: location.href, title: norm(document.title).slice(0, 200), elements, textHash, stateHash: stateHashOf(nodes) });
})()`;

const TEXT_HASH = String.raw`(() => { __HELPERS__ return djb2(visibleText()); })()`;
const STATE_HASH = String.raw`(() => { const REG = ${JSON.stringify(SOM_REGISTRY)}; __HELPERS__ const reg = window[REG]; if (!reg) return "none"; return String(stateHashOf(reg.nodes.filter((el) => el.isConnected))); })()`;
const READ_TEXT = String.raw`(() => { __HELPERS__ return visibleText(); })()`;

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
    // A password never goes through here: it would sit in the chat and in the confirmation log.
    if (String(t.type || "").toLowerCase() === "password") return JSON.stringify({ ok: false, reason: "password" });
    if (t.isContentEditable) { t.focus(); t.textContent = action.text; fire(t, "input"); return JSON.stringify({ ok: true }); }
    if (!("value" in t)) return JSON.stringify({ ok: false, reason: "not a field" });
    t.focus(); setNative(t, ""); fire(t, "input"); setNative(t, action.text); fire(t, "input"); fire(t, "change"); t.blur();
    return JSON.stringify({ ok: true });
  }
  if (action.kind === "select") {
    const s = el.tagName === "LABEL" && el.control ? el.control : el;
    if (s.tagName !== "SELECT") return JSON.stringify({ ok: false, reason: "not a select" });
    const want = action.option.trim().toLowerCase();
    const opt = [...s.options].find((o) => o.text.trim().toLowerCase() === want || o.value.trim().toLowerCase() === want)
      || [...s.options].find((o) => o.text.trim().toLowerCase().includes(want));
    if (!opt) return JSON.stringify({ ok: false, reason: "no such option" });
    s.value = opt.value; fire(s, "input"); fire(s, "change"); return JSON.stringify({ ok: true });
  }
  return JSON.stringify({ ok: false, reason: "unknown action" });
})()`;

const withHelpers = (script: string): string => script.replace("__HELPERS__", () => HELPERS);

export function markScript(epoch: string): string {
  return withHelpers(MARK).replace("__EPOCH__", () => JSON.stringify(epoch));
}

export function textHashScript(): string {
  return withHelpers(TEXT_HASH);
}

export function stateHashScript(): string {
  return withHelpers(STATE_HASH);
}

export function readTextScript(): string {
  return withHelpers(READ_TEXT);
}

export function clearScript(): string {
  return CLEAR;
}

export function actScript(epoch: string, n: number, action: SomAction): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("AGENT_BROWSER_SOM_INDEX_INVALID");
  // Callback replacements: a `$&` typed into a field must not expand into the placeholder.
  return ACT.replace("__EPOCH__", () => JSON.stringify(epoch)).replace("__N__", () => String(n)).replace("__ACTION__", () => JSON.stringify(action));
}
