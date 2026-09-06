/** Only application-authored system context is relocated; persisted history and user data are never edited. */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { AppError } from "./app-error.js";

const BLOCK = /<osinara_turn_memory>\n[\s\S]*?\n<\/osinara_turn_memory>/gu;

export function ephemeralMemoryContext(content: string): string {
  return `<osinara_turn_memory>\n${content}\n</osinara_turn_memory>`;
}

export function placeEphemeralMemoryContext(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  const blocks = prompt.flatMap((message) => message.role === "system" ? [...message.content.matchAll(BLOCK)] : []);
  if (blocks.length === 0) return prompt;
  if (blocks.length !== 1) throw invalidContext();
  const block = blocks[0]!;
  const output = prompt.flatMap((message) => {
    if (message.role !== "system" || !message.content.includes(block[0])) return [message];
    const start = message.content.indexOf(block[0]);
    let before = message.content.slice(0, start), after = message.content.slice(start + block[0].length);
    // Eve joins system fragments with two newlines. Remove this fragment's separator as well,
    // otherwise an absent retrieval block changes the supposedly stable system prefix.
    if (before.endsWith("\n\n")) before = before.slice(0, -2);
    else if (after.startsWith("\n\n")) after = after.slice(2);
    const content = before + after;
    return content.trim() ? [{ ...message, content }] : [];
  });
  // The original question can disappear during native compaction. Appending preserves the whole
  // history prefix and never separates an assistant tool call from its required result.
  output.push({ role: "user", content: [{ type: "text", text: block[0] }] });
  return output;
}

function invalidContext(): AppError {
  return new AppError("AGENT_MODEL_TURN_CONTEXT_INVALID", "Не удалось подготовить контекст памяти для ответа. Повторите сообщение");
}
