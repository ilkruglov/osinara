/**
 * Telegram widget lint.
 *
 * Constructs covered:
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
    expect(lintTelegramWidget(plain, { allowLinks: true })).toEqual({ errors: [], links: [], warnings: [] });
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
    expect(trusted.links).toEqual(["https://maps.yandex.ru/?ll=37,55", "https://example.com/x", "https://t.me/somechannel"]);
    expect(lintTelegramWidget(html, { allowLinks: false }).errors.join("\n")).toMatch(/ссылк/u);
  });

  it("warns about what profile v1 drops silently", () => {
    const html = `<style>@font-face{font-family:X;src:local(X)} .a{font-family:"Roboto",sans-serif;height:50vh;position:sticky;
display:grid;text-shadow:0 0 1px #000;transform:translate3d(0,0,0);overflow:auto}</style>
<form><input value="1"><select></select></form><img src="data:image/png;base64,${"A".repeat(3_000)}">`;
    const { errors, warnings } = lintTelegramWidget(html, { allowLinks: true });
    expect(errors).toEqual([]);
    for (const pattern of [/<input>/u, /<select>/u, /<form>/u, /@font-face/u, /Roboto/u, /vh/u, /sticky/u, /grid/u, /text-shadow/u, /3D/u, /прокрут/iu, /картинк/u]) {
      expect(warnings.join("\n"), String(pattern)).toMatch(pattern);
    }
  });
});
