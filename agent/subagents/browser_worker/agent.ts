/**
 * The browser worker: a child agent that does one multi-step task on a website.
 *
 * Constructs:
 * - A static declared subagent. Eve 0.40.0 stores a dynamic subagent's model as a durable
 *   selection and accepts only a model id string there, and the DeepSeek transport is a provider
 *   object, so a `defineDynamic` here was silently omitted from every surface. A same-name denial
 *   is impossible too (Eve throws on a dynamic tool named like a visible subagent), so the tool
 *   exists in every mode and the browser tools themselves refuse every caller outside a private
 *   chat or family group and every memory-review session.
 * - The context window is declared: the transport reports the OpenAI-compatible provider, and the
 *   compiler would otherwise look the model up in the AI Gateway catalog and fail.
 * - `limits` bound a runaway worker in tokens before Eve's session default; the step budget in the
 *   tool surface only turns tools into refusals.
 * - The primary model at low reasoning effort: each step is one action, and the person is
 *   waiting. The step budget lives in the tool surface (`tools/capabilities.ts`): past it the
 *   browser tools become refusals.
 * - Its own tool surface: the browser tools, image inspection, and nothing else;
 *   `browser_confirm` stays with the root, where the person is asked.
 */
import { defineAgent } from "eve";

import { AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS, AGENT_COMPACTION_THRESHOLD, BROWSER_WORKER_MAX_INPUT_TOKENS_PER_SESSION } from "../../config.js";
import { browserWorkerModel } from "../../lib/model-registry.js";
import { modelProviderConfig } from "../../lib/model-provider-config.js";

const workerContextWindowTokens = Math.min(modelProviderConfig.agent.models.primary.contextWindowTokens, AGENT_COMPACTION_CONTEXT_WINDOW_TOKENS);

export default defineAgent({
  compaction: { modelContextWindowTokens: workerContextWindowTokens, thresholdPercent: AGENT_COMPACTION_THRESHOLD },
  description: "Делает многошаговую задачу на сайте в браузере семьи: запись, бронь, форма, личный кабинет, поиск на сайте. Сообщение должно быть самодостаточным: сайт или адрес входа, что именно выбрать, какие поля анкеты можно подставлять, что спросить у человека. Возвращает done с цитатой со страницы, blocked с причиной, needs_input с вопросом или awaiting_confirmation с epoch и номером кнопки.",
  limits: { maxInputTokensPerSession: BROWSER_WORKER_MAX_INPUT_TOKENS_PER_SESSION },
  model: browserWorkerModel,
  modelContextWindowTokens: workerContextWindowTokens,
});
