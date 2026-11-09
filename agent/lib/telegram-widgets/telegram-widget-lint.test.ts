/**
 * Telegram widget lint.
 *
 * Constructs covered:
 * - Links hidden by entities, by a «>» inside an earlier attribute, in SVG, behind javascript:, a
 *   meta refresh or a computed openLink are refused where links are not allowed; network resources
 *   hidden in srcset, poster or CSS escapes are refused everywhere.
 * - Errors are what breaks the card in Telegram: external images, scripts or styles, CSS `url()`
 *   to the network, `@import`, SVG as an image, network calls from the script.
 * - Links are collected (anchors and `openLink`/`openTelegramLink` literals); where links are not
 *   allowed, any link is an error.
 * - Warnings are what profile v1 drops silently: form controls, `@font-face`, viewport height,
 *   sticky positioning, grid, text shadow, 3D transforms, inner scrolling, heavy inline pictures.
 * - A plain card passes with nothing to report.
 */
import { describe, expect, it } from "vitest";

import { lintTelegramWidget } from "./telegram-widget-lint.js";

const plain = `<style>.c{display:flex;gap:8px;color:var(--tg-theme-text-color,#111)}</style>
<div class="c"><b>Ккал</b><span>1 840</span></div>
<svg width="100" height="20"><rect width="60" height="20" fill="#2a7"/></svg>
<script>document.querySelector('.c').addEventListener('click',()=>{});</script>`;

describe("lintTelegramWidget", () => {
  it("lets a plain card through with nothing to report", () => {
    expect(lintTelegramWidget(plain, { allowLinks: true })).toEqual({
      errors: [],
      links: [],
      warnings: [],
    });
  });

  it("refuses what breaks the card: network resources, @import, SVG images, network calls", () => {
    const html = `<style>@import url(x.css); .b{background:url(https://example.com/a.png)}</style>
<img src="https://example.com/a.png"><img src="//cdn.example.com/b.png"><img src="data:image/svg+xml;base64,PHN2Zz4=">
<script src="https://cdn.example.com/x.js"></script><script>fetch('/api'); new WebSocket('wss://x');</script>`;
    const { errors } = lintTelegramWidget(html, { allowLinks: true });
    expect(errors.join("\n")).toMatch(/<img src="https:\/\/example.com\/a.png">/u);
    expect(errors.join("\n")).toMatch(/\/\/cdn.example.com\/b.png/u);
    expect(errors.join("\n")).toMatch(/svg\+xml/u);
    expect(errors.join("\n")).toMatch(/<script src/u);
    expect(errors.join("\n")).toMatch(/url\(https/u);
    expect(errors.join("\n")).toMatch(/@import/u);
    expect(errors.join("\n")).toMatch(/fetch/u);
    expect(errors.join("\n")).toMatch(/WebSocket/u);
  });

  it("collects links and refuses them where links are not allowed", () => {
    const html = `<a href="https://maps.yandex.ru/?ll=37,55">карта</a><a href="#top">наверх</a>
<button onclick="TelegramWidget.openLink('https://example.com/x')">открыть</button>
<button onclick="TelegramWidget.openTelegramLink('https://t.me/somechannel')">канал</button>`;
    const trusted = lintTelegramWidget(html, { allowLinks: true });
    expect(trusted.errors).toEqual([]);
    expect(trusted.links).toEqual([
      "https://maps.yandex.ru/?ll=37,55",
      "https://example.com/x",
      "https://t.me/somechannel",
    ]);
    expect(lintTelegramWidget(html, { allowLinks: false }).errors.join("\n")).toMatch(/ссылк/u);
  });

  // Codex review of 1.8.55: each of these passed the external no-link rule with no error and no link.
  it.each([
    ["an entity-encoded scheme", `<a href="https&#58;//example.com/">x</a>`],
    ["a hex entity in the scheme", `<a href="https&#x3a;//example.com/">x</a>`],
    ["a «>» in an earlier attribute", `<a title=">" href="https://example.com/">x</a>`],
    ["an SVG link", `<svg><a xlink:href="https://example.com/"><text>x</text></a></svg>`],
    ["a javascript: link", `<a href="javascript:void(0)">x</a>`],
    ["a meta refresh", `<meta http-equiv="refresh" content="0;url=https://example.com/">`],
    [
      "an openLink call with a computed address",
      `<button onclick="var u='https://example.com/';TelegramWidget.openLink(u)">x</button>`,
    ],
    ["window.open", `<script>window.open("https://example.com/")</script>`],
  ])("refuses %s where links are not allowed", (_name, html) => {
    expect(lintTelegramWidget(html, { allowLinks: false }).errors.join("\n")).toMatch(/ссылк/u);
  });

  // Second Codex pass on the lint fix, 6 November 2026.
  it.each([
    [
      "an entity inside a script attribute",
      `<button onclick="TelegramWidget.open&#76;ink('https://example.com')">x</button>`,
    ],
    ["a second href the browser ignores", `<a href="https://example.com/" href="#">x</a>`],
  ])("still refuses %s where links are not allowed", (_name, html) => {
    expect(lintTelegramWidget(html, { allowLinks: false }).errors.join("\n")).toMatch(/ссылк/u);
  });

  // /code-review of 1.8.57–1.8.58, 9 November 2026: the tag pattern required a space before every
  // attribute, so a tag whose attribute followed «/» or a closing quote was not seen at all.
  it.each([
    ["an attribute after «/»", `<a/href="https://example.com/">x</a>`],
    ["an attribute right after a closing quote", `<a title="t"href="https://example.com/">x</a>`],
    ["an attribute after a stray quote", `<a data-x=y' href="https://example.com/">x</a>`],
  ])("refuses a link behind %s where links are not allowed", (_name, html) => {
    expect(lintTelegramWidget(html, { allowLinks: false }).links).toEqual(["https://example.com/"]);
  });

  // Codex review of the fix, 9 November 2026: a quote opens a value only right after «=»; inside an
  // unquoted value a quote or «=» is an ordinary character, and only HTML whitespace separates.
  it.each([
    [
      "a quote inside an unquoted value",
      `<div data-x=x' href="">hello</div><a href="https://example.com/">x</a><div data-x=y'>end</div>`,
    ],
    [
      "«=» and a quote inside an unquoted value",
      `<div data-x=a="b><a href="https://example.com/">x</a>">`,
    ],
    [
      "a no-break space, which is no separator to the browser",
      `<a title=x\u00a0href=a href="https://example.com/">x</a>`,
    ],
  ])("does not let %s hide the next link", (_name, html) => {
    expect(lintTelegramWidget(html, { allowLinks: false }).links).toEqual(["https://example.com/"]);
  });

  // Codex review, 9 November 2026: a pattern that consumed its matches let a false tag inside a
  // comment or a <style> swallow the real link after it; every tag is now read from its own «<».
  it.each([
    [
      "a comment with an unclosed quote",
      `<!-- <div title=" --><a href='https://example.com/'>go</a>`,
    ],
    [
      "a comment whose quote closes later",
      `<!-- <div title=" --><a href='https://example.com/'>go</a><p title="x">`,
    ],
    ["a CSS comment", `<style>/*<div title="*/</style><a href='https://example.com/'>go</a>`],
    [
      "a comment before an area link",
      `<!-- <div title=" --><map><area href="https://example.com/"></map>`,
    ],
  ])("does not let a false tag in %s swallow the real link after it", (_name, html) => {
    expect(lintTelegramWidget(html, { allowLinks: false }).links).toEqual(["https://example.com/"]);
  });

  it("does not let a false tag in a comment hide an external image", () => {
    const html = `<!-- <div title=" --><img src="https://example.com/p.png">`;
    expect(lintTelegramWidget(html, { allowLinks: true }).errors.join("\n")).toMatch(
      /Внешний ресурс не загрузится/u,
    );
  });

  it("refuses a card whose tags overlap past what is read, telling how to fix it", () => {
    const lint = lintTelegramWidget(`<a b="`.repeat(5_000), { allowLinks: true });
    expect(lint.errors.join("\n")).toMatch(/слишком запутанная/u);
  });

  it.each([
    ["quote pairs without a closing «>»", `<a ${'"x"'.repeat(40)}'`],
    ["tags whose quoted values never close", `<a b="`.repeat(5_000)],
    ["tags whose single quotes never close", `<a b='x `.repeat(4_000)],
    ["unquoted values full of quotes", `<a b=x"y'z `.repeat(3_000)],
  ])("reads a card of %s in linear time", (_name, html) => {
    const started = performance.now();
    lintTelegramWidget(html, { allowLinks: false });
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("refuses an external image behind «/» before its attribute", () => {
    expect(
      lintTelegramWidget(`<img/src="https://example.com/p.png">`, { allowLinks: true }).errors.join(
        "\n",
      ),
    ).toMatch(/Внешний ресурс не загрузится/u);
  });

  it("does not take a field named location for navigation", () => {
    const html = `<script>var item={location:"Москва"};if (item.location==="Москва") draw();</script>`;
    expect(lintTelegramWidget(html, { allowLinks: false }).errors).toEqual([]);
    expect(
      lintTelegramWidget(`<script>window.location = "https://example.com"</script>`, {
        allowLinks: false,
      }).errors.join("\n"),
    ).toMatch(/ссылк/u);
  });

  it("still refuses an external stylesheet, which is a resource and not a link", () => {
    const lint = lintTelegramWidget(
      `<link rel="stylesheet" href="https://example.com/a.css"><p>x</p>`,
      { allowLinks: true },
    );
    expect(lint.errors.join("\n")).toMatch(/не загрузится/u);
    expect(lint.links).toEqual([]);
  });

  it.each([
    ["srcset", `<img srcset="https://example.com/a.png 1x, data:image/png;base64,AA 2x">`],
    ["a CSS-escaped url()", `<style>.a{background:url(h\\74tps://example.com/a.png)}</style>`],
    ["poster", `<video poster="https://example.com/p.png"></video>`],
  ])("refuses a network resource hidden in %s", (_name, html) => {
    expect(lintTelegramWidget(html, { allowLinks: true }).errors.join("\n")).toMatch(
      /не загрузится/u,
    );
  });

  it("warns about what profile v1 drops silently", () => {
    const html = `<style>@font-face{font-family:X;src:local(X)} .a{font-family:"Roboto",sans-serif;height:50vh;position:sticky;
display:grid;text-shadow:0 0 1px #000;transform:translate3d(0,0,0);overflow:auto}</style>
<form><input value="1"><select></select></form><img src="data:image/png;base64,${"A".repeat(3_000)}">`;
    const { errors, warnings } = lintTelegramWidget(html, { allowLinks: true });
    expect(errors).toEqual([]);
    for (const pattern of [
      /<input>/u,
      /<select>/u,
      /<form>/u,
      /@font-face/u,
      /Roboto/u,
      /vh/u,
      /sticky/u,
      /grid/u,
      /text-shadow/u,
      /3D/u,
      /прокрут/iu,
      /картинк/u,
    ]) {
      expect(warnings.join("\n"), String(pattern)).toMatch(pattern);
    }
  });
});
