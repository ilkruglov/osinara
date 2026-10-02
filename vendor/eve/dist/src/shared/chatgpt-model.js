const DEFAULT_CHATGPT_MODEL_ID = `gpt-5.6-sol`,
  CHATGPT_MODEL_SELECTION_PREFIX = `chatgpt/`,
  DEFAULT_CHATGPT_MODEL_SELECTION = `${CHATGPT_MODEL_SELECTION_PREFIX}${DEFAULT_CHATGPT_MODEL_ID}`;
function parseChatGptModelSelection(e) {
  if (!e.startsWith(`chatgpt/`)) return;
  let t = e.slice(8);
  return isBareChatGptModelId(t) ? t : void 0;
}
function isChatGptModelRouting(e) {
  return e?.kind === `external` && e.provider === `codex`;
}
function normalizeChatGptModelId(e) {
  let t = e.trim(),
    n = t.startsWith(`openai/`) ? t.slice(7) : t;
  return isBareChatGptModelId(n) ? n : void 0;
}
function isBareChatGptModelId(e) {
  return e.length > 0 && e === e.trim() && !e.includes(`/`);
}
export {
  CHATGPT_MODEL_SELECTION_PREFIX,
  DEFAULT_CHATGPT_MODEL_ID,
  DEFAULT_CHATGPT_MODEL_SELECTION,
  isChatGptModelRouting,
  normalizeChatGptModelId,
  parseChatGptModelSelection,
};
