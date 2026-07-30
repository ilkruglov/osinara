/**
 * MiniMax Anthropic Messages wire compatibility.
 *
 * Export:
 * - `createMiniMaxAnthropicCompatibilityFetch`: preserves MiniMax web-search result content while
 *   translating its field name to and from the Anthropic schema expected by the AI SDK.
 *
 * Key constructs:
 * - Exact block matching leaves ordinary model payloads untouched.
 * - Streaming normalization buffers split SSE lines without buffering the complete response.
 */
import type { FetchFunction } from "@ai-sdk/provider-utils";

import { AppError } from "./app-error.js";

type WireDirection = "from-minimax" | "to-minimax";

const ANTHROPIC_WEB_SEARCH_CONTENT_FIELD = "encrypted_content";
const MAX_SSE_LINE_CHARACTERS = 2_000_000;
const MINIMAX_WEB_SEARCH_CONTENT_FIELD = "content";
const WEB_SEARCH_RESULT_TYPE = "web_search_result";
const WEB_SEARCH_TOOL_RESULT_TYPE = "web_search_tool_result";

function parseWireJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    // Preserve the parser error and stack while making provider-boundary failures diagnosable.
    if (error instanceof Error) {
      Object.defineProperty(error, "message", {
        configurable: true,
        value: `AGENT_MINIMAX_ANTHROPIC_PAYLOAD_INVALID: MiniMax передал некорректный JSON: ${error.message}`,
        writable: true,
      });
    }
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rewriteSearchResult(value: unknown, direction: WireDirection): unknown {
  const result = record(value);
  if (!result || result.type !== WEB_SEARCH_RESULT_TYPE) return value;

  const sourceField = direction === "from-minimax"
    ? MINIMAX_WEB_SEARCH_CONTENT_FIELD
    : ANTHROPIC_WEB_SEARCH_CONTENT_FIELD;
  const targetField = direction === "from-minimax"
    ? ANTHROPIC_WEB_SEARCH_CONTENT_FIELD
    : MINIMAX_WEB_SEARCH_CONTENT_FIELD;
  const source = result[sourceField];
  if (typeof source !== "string" || result[targetField] !== undefined) return value;

  // Move the exact opaque value rather than manufacturing an Anthropic encrypted payload.
  const rewritten = { ...result, [targetField]: source };
  delete rewritten[sourceField];
  return rewritten;
}

function rewriteToolResultBlock(value: unknown, direction: WireDirection): unknown {
  const block = record(value);
  if (!block || block.type !== WEB_SEARCH_TOOL_RESULT_TYPE || !Array.isArray(block.content)) {
    return value;
  }
  return {
    ...block,
    content: block.content.map((result) => rewriteSearchResult(result, direction)),
  };
}

function rewriteIncomingPayload(value: unknown): unknown {
  const payload = record(value);
  if (!payload) return value;

  // Streaming content blocks and complete JSON messages expose results at different levels.
  if (payload.type === "content_block_start") {
    return { ...payload, content_block: rewriteToolResultBlock(payload.content_block, "from-minimax") };
  }
  if (Array.isArray(payload.content)) {
    return {
      ...payload,
      content: payload.content.map((block) => rewriteToolResultBlock(block, "from-minimax")),
    };
  }
  return value;
}

function rewriteOutgoingPayload(value: unknown): unknown {
  const payload = record(value);
  if (!payload || !Array.isArray(payload.messages)) return value;
  return {
    ...payload,
    messages: payload.messages.map((messageValue) => {
      const message = record(messageValue);
      if (!message || !Array.isArray(message.content)) return messageValue;
      return {
        ...message,
        content: message.content.map((block) => rewriteToolResultBlock(block, "to-minimax")),
      };
    }),
  };
}

function requestUrl(input: Parameters<FetchFunction>[0]): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

function rewriteRequest(
  input: Parameters<FetchFunction>[0],
  init: Parameters<FetchFunction>[1],
): Parameters<FetchFunction>[1] {
  if (!requestUrl(input).pathname.endsWith("/messages") || typeof init?.body !== "string") {
    return init;
  }
  return { ...init, body: JSON.stringify(rewriteOutgoingPayload(parseWireJson(init.body))) };
}

function rewriteSseLine(line: string): string {
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  const content = carriageReturn ? line.slice(0, -1) : line;
  if (!content.startsWith("data:") || !content.includes(WEB_SEARCH_TOOL_RESULT_TYPE)) return line;
  const data = content.slice("data:".length).trimStart();
  if (!data || data === "[DONE]") return line;
  return `data: ${JSON.stringify(rewriteIncomingPayload(parseWireJson(data)))}${carriageReturn}`;
}

function assertSseLineBound(buffer: string): void {
  if (buffer.length <= MAX_SSE_LINE_CHARACTERS) return;
  throw new AppError(
    "AGENT_MINIMAX_ANTHROPIC_SSE_LIMIT_EXCEEDED",
    "MiniMax передал слишком большой потоковый блок ответа",
  );
}

function rewriteSseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        assertSseLineBound(buffer);
        controller.enqueue(encoder.encode(rewriteSseLine(buffer)));
      }
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        assertSseLineBound(line);
        buffer = buffer.slice(newlineIndex + 1);
        controller.enqueue(encoder.encode(`${rewriteSseLine(line)}\n`));
        newlineIndex = buffer.indexOf("\n");
      }
      assertSseLineBound(buffer);
    },
  }));
}

function rewrittenResponse(response: Response, body: BodyInit): Response {
  const headers = new Headers(response.headers);
  // Body bytes changed, so upstream compression and length metadata no longer describe them.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function rewriteResponse(response: Response): Promise<Response> {
  if (!response.ok || response.body === null) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType?.includes("text/event-stream")) {
    return rewrittenResponse(response, rewriteSseBody(response.body));
  }
  if (contentType?.includes("application/json")) {
    const payload = rewriteIncomingPayload(parseWireJson(await response.text()));
    return rewrittenResponse(response, JSON.stringify(payload));
  }
  return response;
}

export function createMiniMaxAnthropicCompatibilityFetch(fetch: FetchFunction): FetchFunction {
  return async (input, init) => {
    const response = await fetch(input, rewriteRequest(input, init));
    return await rewriteResponse(response);
  };
}
