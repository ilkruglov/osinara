/**
 * The person's shopping lists, in their private chat.
 *
 * Export:
 * - `manage_shopping_list`: add a line, show a list, mark bought, unmark, remove.
 */
import { defineTool } from "eve/tools";

import { requireMemoryAuthorization } from "../memory-context.js";
import { shoppingInput, shoppingRepository } from "../shopping/shopping-repository.js";

export default defineTool({
  description: [
    "Личные списки покупок человека: add добавляет пункт, list показывает, buy отмечает купленным, unbuy снимает отметку, remove убирает пункт. Семейная группа списки не видит.",
    "add: title обязателен; listName по умолчанию «покупки», другие списки по имени (дача, стройка); quantity свободным текстом (2 пачки, 500 г), note для уточнения.",
    "list: listName ограничивает одним списком, view open|bought|all, по умолчанию open; страницы по 100 пунктов, page для следующей, hasMore в ответе. В ответе id и version каждого пункта.",
    "buy, unbuy, remove: id и актуальная version из list. Если version устарела, прочитай список заново и не угадывай.",
    "Одинаковые названия не объединяются: два пакета молока это намеренно два пункта. Для корзины ВкусВилла по списку есть grocery_cart.",
  ].join(" "),
  inputSchema: shoppingInput,
  async execute(input, ctx) {
    return await shoppingRepository.execute(requireMemoryAuthorization(ctx), input, `${ctx.session.id}:${ctx.callId}`);
  },
});
