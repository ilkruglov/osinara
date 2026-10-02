import type { ModelRouting } from "./agent-definition.js";
export declare const DEFAULT_CHATGPT_MODEL_ID = "gpt-5.6-sol";
export declare const CHATGPT_MODEL_SELECTION_PREFIX = "chatgpt/";
export declare const DEFAULT_CHATGPT_MODEL_SELECTION = "chatgpt/gpt-5.6-sol";
/** Returns the bare OpenAI model id encoded by a setup-facing ChatGPT selection. */
export declare function parseChatGptModelSelection(selection: string): string | undefined;
export declare function isChatGptModelRouting(routing: ModelRouting | null | undefined): boolean;
/** Normalizes the model argument accepted by the public `chatgpt()` helper. */
export declare function normalizeChatGptModelId(model: string): string | undefined;
