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
