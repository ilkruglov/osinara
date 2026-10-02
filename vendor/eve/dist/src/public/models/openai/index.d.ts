import type { LanguageModel } from "ai";
/**
 * Creates a language model billed to the local ChatGPT subscription instead
 * of an API key, served through the Codex backend the `codex login` flow
 * authorizes.
 *
 * Defaults to `gpt-5.6-sol`. Pass a bare OpenAI model slug or an
 * `openai/`-prefixed id to override it; the Codex backend serves OpenAI models
 * only, so any other provider-qualified id is rejected. Model availability is
 * enforced by the Codex backend per account at call time, not at compile time.
 *
 * Credentials are read from the Codex CLI login on the machine the agent
 * runs on, so this model works in local dev and fails in a deployment.
 * Branch on environment for production:
 *
 * ```ts
 * export default defineAgent({
 *   model:
 *     process.env.NODE_ENV === "production"
 *       ? "anthropic/claude-sonnet-4.6"
 *       : chatgpt(),
 * });
 * ```
 */
export declare function chatgpt(model?: string): LanguageModel;
/** @deprecated Use {@link chatgpt}. */
export declare const experimental_chatgpt: typeof chatgpt;
