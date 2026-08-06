/**
 * Isolated universal task worker configuration.
 *
 * Export:
 * - A fresh-context specialist using the root model capacity with a separately declared surface.
 */
import { defineAgent } from "eve";

import { primaryModel } from "../../lib/model-registry.js";
import { modelProviderConfig } from "../../lib/model-provider-config.js";

const primaryModelContextWindowTokens =
  modelProviderConfig.agent.models.primary.contextWindowTokens;

export default defineAgent({
  description:
    "Выполняет большие изолированные задачи: анализирует подготовленные материалы, структурирует данные и создаёт черновики документов без сети и внешних mutations.",
  model: primaryModel,
  modelContextWindowTokens: primaryModelContextWindowTokens,
});
