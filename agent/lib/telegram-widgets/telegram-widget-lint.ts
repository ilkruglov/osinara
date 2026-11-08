/**
 * Static check of a model-authored Telegram widget before it is sent.
 *
 * Exports:
 * - `lintTelegramWidget`: errors (the card would break), links (every external address the card can
 *   open) and warnings (what Telegram's widget profile v1 drops silently).
 *
 * Key constructs:
 * - Errors are only what certainly breaks the card in the client: a widget has no network, so an
 *   external image, script or stylesheet becomes a placeholder or nothing, `@import` and CSS `url()`
 *   to the network are dropped, SVG is not an image format there, and `fetch`/`WebSocket` throw.
 * - Links are reported, never rewritten: the card is written by the model from chat text, and an
 *   address planted in the chat could end up behind a button. Where links are not allowed at all,
 *   any link is an error.
 * - Warnings teach rather than block: profile v1 drops form controls, `@font-face`, named fonts,
 *   viewport height, sticky positioning, 3D transforms and inner scrolling, and grid is not on every
 *   client; an inline picture of a few kilobytes eats most of the 4 KB budget.
 * - Regular expressions, not a parser: the check names the construct with a short excerpt so the
 *   model can find it; Telegram's own validator remains the boundary. Attribute values are read as
 *   the browser reads them (entities decoded, a «>» inside quotes kept in the tag), CSS with its
 *   escapes decoded, srcset address by address. Where links are not allowed, a javascript: link, a
 *   meta refresh and the script's means of opening an address (openLink, window.open, location)
 *   are refused too: an address the script builds cannot be checked statically (Codex review of 1.8.55).
 */
export interface TelegramWidgetLint {
  errors: string[];
  links: string[];
  warnings: string[];
}

const NETWORK_URL = /^\s*(?:https?:)?\/\//iu;
// A tag with its attributes; a quoted value may hold «>», so the tag ends only outside quotes.
const TAG =
  /<([a-z][a-z0-9-]*)((?:\s+[^\s=>"'/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?>/giu;
const ATTRIBUTE = /([^\s=>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/giu;
const OPEN_LINK = /\bopen(?:Telegram)?Link\s*\(\s*(["'`])([^"'`]+)\1/gu;
// Ways a card can leave for an address that a literal check cannot follow: when links are not
// allowed, using them at all is refused.
// `location` alone or of window/document/top/self/parent, assigned or called; a field of another
// object (`item.location`) and a comparison (`location === …`) are not navigation.
const NAVIGATION_APIS = new RegExp(
  [
    String.raw`\bopen(?:Telegram)?Link\b`,
    String.raw`\bwindow\s*\.\s*open\s*\(`,
    String.raw`(?:(?<![.\w$])|\b(?:window|document|top|self|parent)\s*\.\s*)location\s*(?:=(?!=)|\.\s*href\s*=(?!=)|\.\s*(?:assign|replace)\s*\()`,
  ].join("|"),
  "u",
);
// Elements whose href opens an address; on any other element (a stylesheet <link>, SVG <use>,
// <image>) the href loads a resource.
const LINK_ELEMENTS = new Set(["a", "area"]);
const HREF_ATTRIBUTES = new Set(["href", "xlink:href"]);
const RESOURCE_ATTRIBUTES = new Set([
  "src",
  "poster",
  "data",
  "background",
  "action",
  "formaction",
]);
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  colon: ":",
  gt: ">",
  lpar: "(",
  lt: "<",
  newline: "\n",
  period: ".",
  quot: '"',
  rpar: ")",
  sol: "/",
  tab: "\t",
};

/** An attribute value as the browser reads it: entities like `&#58;` or `&colon;` decoded. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/giu, (whole, decimal, hex, name) => {
    if (decimal !== undefined || hex !== undefined) {
      const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? whole;
  });
}

/** CSS as the browser reads it: `\74` and the like decoded, so an escaped address is seen too. */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-f]{1,6})\s?/giu, (whole, hex) => {
    const code = Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

export function lintTelegramWidget(
  html: string,
  options: { allowLinks: boolean },
): TelegramWidgetLint {
  const errors: string[] = [];
  const links: string[] = [];
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const handlers: string[] = [];
  for (const tag of html.matchAll(TAG)) {
    const name = tag[1]!.toLowerCase();
    const attributes = new Map<string, string>();
    for (const attribute of tag[2]!.matchAll(ATTRIBUTE)) {
      // The browser keeps the first of repeated attributes.
      const attributeName = attribute[1]!.toLowerCase();
      if (!attributes.has(attributeName)) {
        attributes.set(
          attributeName,
          decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""),
        );
      }
    }
    for (const [attribute, value] of attributes) {
      // Script in an event attribute runs decoded: `open&#76;ink` is openLink there.
      if (attribute.startsWith("on")) handlers.push(value);
      if (HREF_ATTRIBUTES.has(attribute) && LINK_ELEMENTS.has(name)) {
        if (NETWORK_URL.test(value)) links.push(value.trim());
        // A javascript: address runs code that may open anything; it counts as a link.
        else if (/^\s*javascript:/iu.test(value)) links.push(value.trim());
        continue;
      }
      if (name === "script" && attribute === "src") {
        errors.push(
          `<script src> не загрузится: у виджета нет сети, код пиши прямо в <script> (${excerpt(tag[0])})`,
        );
        continue;
      }
      // srcset lists several addresses, each followed by its size.
      const addresses =
        attribute === "srcset"
          ? value.split(",").map((candidate) => candidate.trim().split(/\s+/u)[0] ?? "")
          : RESOURCE_ATTRIBUTES.has(attribute) || HREF_ATTRIBUTES.has(attribute)
            ? [value]
            : [];
      for (const address of addresses) {
        if (NETWORK_URL.test(address)) {
          errors.push(
            `Внешний ресурс не загрузится, Telegram покажет заглушку: ${excerpt(tag[0])}. Рисуй SVG или вшей маленькую картинку data:-адресом`,
          );
        } else if (/^\s*data:image\/svg\+xml/iu.test(address)) {
          errors.push(
            `SVG картинкой (data:image/svg+xml) Telegram не показывает: вставь <svg> прямо в разметку (${excerpt(tag[0])})`,
          );
        } else if (/^\s*data:image\//iu.test(address) && address.length > 2_000) {
          warn(
            `Вшитая картинка ${address.length} знаков съедает большую часть лимита 4 КБ: лучше SVG, CSS или текст`,
          );
        }
      }
    }
    if (name === "meta" && /^\s*refresh\s*$/iu.test(attributes.get("http-equiv") ?? "")) {
      // A refresh to an address is navigation, the same as a link.
      const target = /url\s*=\s*(\S+)/iu.exec(attributes.get("content") ?? "")?.[1];
      links.push(target ?? "meta refresh");
    }
    if (
      ["input", "select", "textarea", "form", "iframe", "video", "audio", "option"].includes(name)
    ) {
      warn(
        `<${name}> Telegram выбросит вместе с содержимым: в виджете нет полей ввода и медиа, есть <button> и <details>`,
      );
    }
  }

  // Scripts as written, event attributes as the browser decodes them.
  const executable = [html, ...handlers].join("\n");
  for (const call of executable.matchAll(OPEN_LINK)) {
    const address = call[2]!.trim();
    // A handler is seen twice, as written and decoded; its address is one link.
    if (!links.includes(address)) links.push(address);
  }
  if (/@import\b/iu.test(html)) errors.push("@import не работает: стили пиши прямо в <style>");
  for (const css of decodeCssEscapes(html).matchAll(/url\(\s*["']?((?:https?:)?\/\/[^)"']+)/giu)) {
    errors.push(`url(${excerpt(css[1]!)}) в CSS не загрузится: у виджета нет сети`);
  }
  for (const api of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
    if (new RegExp(`\\b${api}\\s*\\(|new\\s+${api}\\b`, "u").test(html)) {
      errors.push(`${api} в виджете не работает: сети нет, все данные клади в сам HTML`);
    }
  }
  if (!options.allowLinks && links.length > 0) {
    errors.push(
      `В этом чате ссылки в виджете запрещены, убери их: ${links.map(excerpt).join(", ")}`,
    );
  } else if (!options.allowLinks && NAVIGATION_APIS.test(executable)) {
    // An address built in the script cannot be read here, so the means to open one is refused.
    errors.push(
      "В этом чате ссылки в виджете запрещены: убери openLink, window.open и переходы через location",
    );
  }

  if (/@font-face\b/iu.test(html))
    warn(
      "@font-face Telegram выбросит: доступны только системные шрифты (system-ui, sans-serif, serif, monospace)",
    );
  for (const family of html.matchAll(/font-family\s*:\s*([^;}"']*["'][^"']+["'][^;}]*)/giu)) {
    warn(
      `Названные шрифты выбрасываются, останутся только системные: font-family: ${excerpt(family[1]!)}`,
    );
  }
  if (/\b\d+(?:\.\d+)?(?:vh|dvh|svh)\b/iu.test(html))
    warn("Единицы vh/dvh/svh не работают: высоту задавай в px или по содержимому");
  if (/position\s*:\s*sticky/iu.test(html)) warn("position: sticky станет relative");
  if (/display\s*:\s*(?:inline-)?grid/iu.test(html))
    warn("display: grid есть не у всех клиентов: раскладку делай flex или таблицей");
  if (/text-shadow\s*:/iu.test(html)) warn("text-shadow Telegram выбросит");
  if (
    /\b(?:translate3d|rotate3d|scale3d|perspective|translateZ|rotateX|rotateY)\s*\(|perspective\s*:/iu.test(
      html,
    )
  ) {
    warn("3D-трансформации выбрасываются: только 2D (translate, rotate, scale)");
  }
  if (/overflow(?:-[xy])?\s*:\s*(?:auto|scroll)/iu.test(html))
    warn(
      "Прокрутки внутри виджета нет: overflow auto/scroll станет hidden, всё должно влезать в 600 px высоты",
    );
  if (/:focus\b|:has\(/iu.test(html)) warn(":focus и :has() не срабатывают");
  return { errors, links, warnings };
}
