/**
 * The grocery catalogue: its source and the limits.
 *
 * Exports:
 * - `GROCERY_MCP_URL`, `GROCERY_AVAILABLE`: the MCP endpoint and whether it is usable.
 * - Limits of a search page, a batch, a cart and a request.
 *
 * Key constructs:
 * - The source is the official public MCP server of ВкусВилл (https://mcp.vkusvill.ru/mcp): read
 *   without a key, so the bot has no access to anyone's account. It assembles a cart link; the
 *   person opens it, chooses the address and pays. `GROCERY_MCP_URL` overrides the endpoint.
 * - Ported from artkruglov/homka (Apache-2.0) on 26 сентября 2026.
 */
export const GROCERY_MCP_URL = process.env.GROCERY_MCP_URL ?? "https://mcp.vkusvill.ru/mcp";
export const GROCERY_AVAILABLE = /^https:\/\/[a-z0-9.-]+\/[\w./-]*$/iu.test(GROCERY_MCP_URL);

/** The source pages by ten; the model needs no more. */
export const GROCERY_SEARCH_MAX_ITEMS = 10;
/** Titles of a shopping list searched by one call: one model step, requests still one by one. */
export const GROCERY_SEARCH_MAX_QUERIES = 8;
/** Shorter rows in a batch: eight titles by ten rows do not read. */
export const GROCERY_BATCH_ITEMS_PER_QUERY = 4;
/** The source accepts no more than twenty positions per cart link. */
export const GROCERY_CART_MAX_ITEMS = 20;
export const GROCERY_CART_MIN_QUANTITY = 0.01;
export const GROCERY_CART_MAX_QUANTITY = 40;
export const GROCERY_REQUEST_TIMEOUT_MS = 15_000;
/** The source is open to everyone behind one shared rate limit: after a refusal it rests. */
export const GROCERY_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000;
/** One retry of a read after a short pause covers a chance collision of requests. */
export const GROCERY_READ_RETRY_DELAY_MS = 2_000;
/** A catalogue answer does not age within a conversation, and a repeat costs an attempt. */
export const GROCERY_CACHE_TTL_MS = 10 * 60_000;
export const GROCERY_CACHE_MAX_ENTRIES = 200;
