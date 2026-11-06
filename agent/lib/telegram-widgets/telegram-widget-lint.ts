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
 *   model can find it; Telegram's own validator remains the boundary.
 */
export interface TelegramWidgetLint {
  errors: string[];
  links: string[];
  warnings: string[];
}

const NETWORK_URL = /^\s*(?:https?:)?\/\//iu;
const TAG = /<([a-z][a-z0-9-]*)\b([^>]*)>/giu;
const ATTRIBUTE = /\b(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
const OPEN_LINK = /\bopen(?:Telegram)?Link\s*\(\s*(["'`])([^"'`]+)\1/gu;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

export function lintTelegramWidget(html: string, options: { allowLinks: boolean }): TelegramWidgetLint {
  const errors: string[] = [];
  const links: string[] = [];
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  for (const tag of html.matchAll(TAG)) {
    const name = tag[1]!.toLowerCase();
    for (const attribute of tag[2]!.matchAll(ATTRIBUTE)) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      if (name === "a" && attribute[1]!.toLowerCase() === "href") {
        if (NETWORK_URL.test(value)) links.push(value.trim());
        continue;
      }
      if (name === "script" && attribute[1]!.toLowerCase() === "src") {
        errors.push(`<script src> не загрузится: у виджета нет сети, код пиши прямо в <script> (${excerpt(tag[0])})`);
        continue;
      }
      if (NETWORK_URL.test(value)) {
        errors.push(`Внешний ресурс не загрузится, Telegram покажет заглушку: ${excerpt(tag[0])}. Рисуй SVG или вшей маленькую картинку data:-адресом`);
      } else if (/^\s*data:image\/svg\+xml/iu.test(value)) {
        errors.push(`SVG картинкой (data:image/svg+xml) Telegram не показывает: вставь <svg> прямо в разметку (${excerpt(tag[0])})`);
      } else if (/^\s*data:image\//iu.test(value) && value.length > 2_000) {
        warn(`Вшитая картинка ${value.length} знаков съедает большую часть лимита 4 КБ: лучше SVG, CSS или текст`);
      }
    }
    if (["input", "select", "textarea", "form", "iframe", "video", "audio", "option"].includes(name)) {
      warn(`<${name}> Telegram выбросит вместе с содержимым: в виджете нет полей ввода и медиа, есть <button> и <details>`);
    }
  }

  for (const call of html.matchAll(OPEN_LINK)) links.push(call[2]!.trim());
  if (/@import\b/iu.test(html)) errors.push("@import не работает: стили пиши прямо в <style>");
  for (const css of html.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^)"']+)/giu)) {
    errors.push(`url(${excerpt(css[1]!)}) в CSS не загрузится: у виджета нет сети`);
  }
  for (const api of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
    if (new RegExp(`\\b${api}\\s*\\(|new\\s+${api}\\b`, "u").test(html)) {
      errors.push(`${api} в виджете не работает: сети нет, все данные клади в сам HTML`);
    }
  }
  if (!options.allowLinks && links.length > 0) {
    errors.push(`В этом чате ссылки в виджете запрещены, убери их: ${links.map(excerpt).join(", ")}`);
  }

  if (/@font-face\b/iu.test(html)) warn("@font-face Telegram выбросит: доступны только системные шрифты (system-ui, sans-serif, serif, monospace)");
  for (const family of html.matchAll(/font-family\s*:\s*([^;}"']*["'][^"']+["'][^;}]*)/giu)) {
    warn(`Названные шрифты выбрасываются, останутся только системные: font-family: ${excerpt(family[1]!)}`);
  }
  if (/\b\d+(?:\.\d+)?(?:vh|dvh|svh)\b/iu.test(html)) warn("Единицы vh/dvh/svh не работают: высоту задавай в px или по содержимому");
  if (/position\s*:\s*sticky/iu.test(html)) warn("position: sticky станет relative");
  if (/display\s*:\s*(?:inline-)?grid/iu.test(html)) warn("display: grid есть не у всех клиентов: раскладку делай flex или таблицей");
  if (/text-shadow\s*:/iu.test(html)) warn("text-shadow Telegram выбросит");
  if (/\b(?:translate3d|rotate3d|scale3d|perspective|translateZ|rotateX|rotateY)\s*\(|perspective\s*:/iu.test(html)) {
    warn("3D-трансформации выбрасываются: только 2D (translate, rotate, scale)");
  }
  if (/overflow(?:-[xy])?\s*:\s*(?:auto|scroll)/iu.test(html)) warn("Прокрутки внутри виджета нет: overflow auto/scroll станет hidden, всё должно влезать в 600 px высоты");
  if (/:focus\b|:has\(/iu.test(html)) warn(":focus и :has() не срабатывают");
  return { errors, links, warnings };
}
