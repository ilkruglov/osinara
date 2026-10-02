import { jsonSchema } from "ai";
import {
  WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA,
  WEB_SEARCH_EXA_OUTPUT_SCHEMA,
  WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA,
  WEB_SEARCH_OPENAI_OUTPUT_SCHEMA,
  WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA,
  WEB_SEARCH_TOOL_DEFINITION,
} from "#runtime/framework-tools/web-search.js";
const UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME = {
  web_search_20250305: WEB_SEARCH_TOOL_DEFINITION.name,
};
function resolveFrameworkToolFromUpstreamType(e) {
  return UPSTREAM_TOOL_TYPE_TO_FRAMEWORK_NAME[e] ?? null;
}
function resolveWebSearchOutputSchema(e) {
  switch (e) {
    case `anthropic`:
      return WEB_SEARCH_ANTHROPIC_OUTPUT_SCHEMA;
    case `exa`:
      return WEB_SEARCH_EXA_OUTPUT_SCHEMA;
    case `google`:
      return WEB_SEARCH_GOOGLE_OUTPUT_SCHEMA;
    case `openai`:
      return WEB_SEARCH_OPENAI_OUTPUT_SCHEMA;
    case `parallel`:
      return WEB_SEARCH_PARALLEL_OUTPUT_SCHEMA;
  }
}
function resolveWebSearchBackend(e, t = `exa`) {
  let o = process.env.OSINARA_WEB_SEARCH_BACKEND;
  if (o) return o;
  let n = e.id.split(`/`)[0] ?? ``;
  if (
    e.source === void 0 &&
    !(
      n === `openai` ||
      n.startsWith(`openai.`) ||
      n === `anthropic` ||
      n.startsWith(`anthropic.`) ||
      n.startsWith(`google.`)
    )
  )
    return t;
  return n === `openai` || n.startsWith(`openai.`)
    ? `openai`
    : n === `anthropic` || n.startsWith(`anthropic.`)
      ? `anthropic`
      : n.startsWith(`google.`)
        ? `google`
        : null;
}
async function resolveWebSearchProviderTool(e) {
  switch (e) {
    case `openai`: {
      let { openai: t } = await import(`#compiled/@ai-sdk/openai/index.js`);
      return attachWebSearchOutputSchema(t.tools.webSearch({}), e);
    }
    case `anthropic`: {
      let { anthropic: t } = await import(
        `#compiled/@ai-sdk/anthropic/index.js`
      );
      return attachWebSearchOutputSchema(t.tools.webSearch_20250305(), e);
    }
    case `google`: {
      let { google: t } = await import(`#compiled/@ai-sdk/google/index.js`);
      return attachWebSearchOutputSchema(t.tools.googleSearch({}), e);
    }
    case `exa`: {
      let { gateway: t } = await import(`ai`);
      return attachWebSearchOutputSchema(
        t.tools.exaSearch({
          contents: { highlights: { maxCharacters: 1e3 } },
          numResults: 10,
        }),
        e,
      );
    }
    case `parallel`: {
      let { gateway: t } = await import(`ai`);
      return attachWebSearchOutputSchema(t.tools.parallelSearch(), e);
    }
  }
}
function attachWebSearchOutputSchema(t, n) {
  return { ...t, outputSchema: jsonSchema(resolveWebSearchOutputSchema(n)) };
}
export {
  resolveFrameworkToolFromUpstreamType,
  resolveWebSearchBackend,
  resolveWebSearchOutputSchema,
  resolveWebSearchProviderTool,
};
