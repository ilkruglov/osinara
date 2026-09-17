import { expect, it, vi } from "vitest";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { boundedLabModel } from "./skill-lab-model.js";

it("reserves every provider attempt, caps output, and removes provider tools", async () => {
  const doGenerate = vi.fn().mockRejectedValue(new Error("provider failed"));
  const model = { specificationVersion: "v4", provider: "test", modelId: "test", supportedUrls: {}, doGenerate } as unknown as LanguageModelV4;
  let attempts = 0;
  const wrapped = boundedLabModel(model, () => { if (++attempts > 2) throw new Error("budget"); }, () => {});
  const input = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "task" }] }],
    tools: [{ type: "provider" as const, id: "p.web" as const, name: "web", args: {} }] };
  await expect(wrapped.doGenerate(input)).rejects.toThrow("provider failed");
  await expect(wrapped.doGenerate(input)).rejects.toThrow("provider failed");
  await expect(wrapped.doGenerate(input)).rejects.toThrow("budget");
  expect(doGenerate).toHaveBeenCalledTimes(2);
  expect(doGenerate.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 2048, tools: [] });
});

it("only exposes frozen scenario tools while still denying provider-native tools", async () => {
  const doGenerate = vi.fn().mockResolvedValue({ usage: {} });
  const model = { specificationVersion: "v4", provider: "test", modelId: "test", supportedUrls: {}, doGenerate } as unknown as LanguageModelV4;
  const wrapped = boundedLabModel(model, () => {}, () => {}, ["web_search"]);
  await wrapped.doGenerate({ prompt: [], tools: [
    { type: "function", name: "web_search", inputSchema: { type: "object" } },
    { type: "function", name: "send_workspace_file", inputSchema: { type: "object" } },
    { type: "provider", id: "p.web", name: "web_search", args: {} },
  ] });
  expect(doGenerate.mock.calls[0][0].tools).toEqual([{ type: "function", name: "web_search", inputSchema: { type: "object" } }]);
});

it("keeps simulated questions out of Eve's human-input control flow without renaming the model contract", async () => {
  const doGenerate = vi.fn().mockResolvedValue({ usage: {}, content: [{ type: "tool-call", toolCallId: "q", toolName: "ask_question", input: "{}" }] });
  const model = { specificationVersion: "v4", provider: "test", modelId: "test", supportedUrls: {}, doGenerate } as unknown as LanguageModelV4;
  const wrapped = boundedLabModel(model, () => {}, () => {}, ["ask_question"]);
  const result = await wrapped.doGenerate({ prompt: [{ role: "tool", content: [{ type: "tool-result", toolCallId: "previous", toolName: "skill_lab_ask_question", output: { type: "text", value: "yes" } }] }], tools: [
    { type: "function", name: "skill_lab_ask_question", inputSchema: { type: "object" } },
  ] });
  expect(doGenerate.mock.calls[0][0].tools[0].name).toBe("ask_question");
  expect(doGenerate.mock.calls[0][0].prompt[0].content[0].toolName).toBe("ask_question");
  expect(result.content[0]).toMatchObject({ toolName: "skill_lab_ask_question" });
});
