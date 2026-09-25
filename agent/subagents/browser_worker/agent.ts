/**
 * The browser worker: a child agent that does one multi-step task on a website.
 *
 * Constructs:
 * - Exposed only in the private chat and the family group of a verified session, never in an
 *   external group and never during the silent memory review; Eve omits it elsewhere.
 * - The primary model at low reasoning effort: each step is one action, and the person is
 *   waiting.
 * - Its own tool surface (`tools/capabilities.ts`): the browser tools, image inspection, and
 *   nothing else; `browser_confirm` stays with the root, where the person is asked.
 */
import { defineAgent, defineDynamic } from "eve";

import { browserWorkerModel } from "../../lib/model-registry.js";
import { isMemoryReviewSession } from "../../lib/memory-review/memory-review-session.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const attributes = ctx.session.auth.current?.attributes;
      const trusted = attributes?.telegramChatType === "private" || attributes?.groupType === "family_private";
      if (!trusted || attributes?.role === "external" || isMemoryReviewSession(ctx)) return null;
      return defineAgent({
        description: "Делает многошаговую задачу на сайте в браузере семьи: запись, бронь, форма, личный кабинет, поиск на сайте. Сообщение должно быть самодостаточным: сайт или адрес входа, что именно выбрать, какие поля анкеты можно подставлять, что спросить у человека. Возвращает done с цитатой со страницы, blocked с причиной, needs_input с вопросом или awaiting_confirmation с epoch и номером кнопки.",
        model: browserWorkerModel,
      });
    },
  },
});
