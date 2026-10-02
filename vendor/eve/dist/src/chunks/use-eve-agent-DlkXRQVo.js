import { computed, onScopeDispose, shallowRef } from "vue";
import { z } from "#compiled/zod/index.js";
import { asSchema } from "ai";

//#region src/protocol/routes.ts
const EVE_ROUTE_PREFIX = "/eve/v1";
const EVE_HEALTH_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/health`;
const EVE_INFO_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/info`;
const EVE_SESSION_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/session`;
const EVE_SESSION_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId`;
const EVE_SESSION_CANCEL_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/cancel`;
const EVE_SESSION_COMPACT_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/compact`;
const EVE_SESSION_CLEAR_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/clear`;
const EVE_SESSION_RESET_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/reset`;
const EVE_SESSION_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/stream`;
const EVE_SUBAGENT_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:parentSessionId/subagents/:callId/:childSessionId/stream`;
const EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/dev/schedules/:scheduleId`;
const EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/dev/runtime-artifacts`;
const EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/rebuild`;
const EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/suspend`;
const EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/resume`;
const EVE_CONNECTION_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/connections/:name/callback/:attemptId/:token`;
const EVE_LEGACY_CONNECTION_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/connections/:name/callback/:token`;
const EVE_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/callback/:token`;
const EVE_TASK_INPUT_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/task-input/:token`;
function createEveSessionRoutePath(sessionId) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}`;
}
function createEveSessionCancelRoutePath(sessionId) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/cancel`;
}
function createEveSessionCompactRoutePath(sessionId) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/compact`;
}
function createEveSessionClearRoutePath(sessionId) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/clear`;
}
function createEveSessionResetRoutePath(sessionId) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/reset`;
}
function createEveSessionStreamRoutePath(sessionId) {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/stream`;
}

//#endregion
//#region src/client/agent-info-error.ts
var AgentInfoResponseError = class extends Error {
  issues;
  constructor(issues = []) {
    const detail = issues.length === 0 ? "" : ` (${issues.join("; ")})`;
    super(
      `The server returned an unrecognized response from the eve agent info route.${detail}`,
    );
    this.name = "AgentInfoResponseError";
    this.issues = issues;
  }
};

//#endregion
//#region src/internal/http/basic-auth.ts
function encodeBasicCredentials(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  const binaryString = Array.from(bytes, (byte) =>
    String.fromCodePoint(byte),
  ).join("");
  return btoa(binaryString);
}

//#endregion
//#region src/client/agent-info-schema.ts
const source = z.object({
  exportName: z.string().optional(),
  logicalPath: z.string(),
  sourceId: z.string().optional(),
  sourceKind: z.string(),
});
const entry = source.extend({ name: z.string() });
const modelRouting = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("gateway"),
    target: z.string(),
    byok: z.string().optional(),
  }),
  z.object({
    kind: z.literal("external"),
    provider: z.string(),
  }),
]);
const modelEndpoint = z.union([
  z.object({
    kind: z.literal("external"),
    provider: z.string(),
  }),
  z.object({
    kind: z.literal("chatgpt"),
    state: z.enum([
      "checking",
      "ready",
      "signed-out",
      "reauth-required",
      "unavailable",
    ]),
    accountLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal("gateway"),
    connected: z.literal(true),
    credential: z.enum(["api-key", "oidc"]),
  }),
  z.object({
    kind: z.literal("gateway"),
    connected: z.literal(false),
  }),
]);
const agentModelBaseFields = {
  contextWindowTokens: z.number().optional(),
  providerOptions: z.unknown().optional(),
  reasoning: z
    .enum([
      "provider-default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ])
    .optional()
    .catch(void 0),
  source: source.optional(),
};
const agentModel = z.union([
  z
    .object({
      ...agentModelBaseFields,
      id: z.string(),
      routing: modelRouting,
      endpoint: modelEndpoint.optional(),
    })
    .strict(),
  z
    .object({
      ...agentModelBaseFields,
      endpoint: z.never().optional(),
      id: z.never().optional(),
      routing: z.object({ kind: z.literal("dynamic") }).strict(),
    })
    .strict(),
]);
const tool = entry.extend({
  description: z.string(),
  hasAuth: z.boolean(),
  hasExecute: z.boolean(),
  hasModelOutputProjection: z.boolean(),
  hasOutputSchema: z.boolean(),
  inputSchema: z.unknown(),
  origin: z.enum(["authored", "framework"]),
  outputSchema: z.unknown().optional(),
  replacesFrameworkTool: z.boolean(),
  requiresApproval: z.boolean(),
});
const frameworkTool = tool.extend({
  disabledByAuthor: z.boolean(),
  replacedByAuthoredTool: z.boolean(),
  status: z.enum(["active", "disabled", "opt-in", "replaced"]),
});
const dynamicResolver = source.extend({
  eventNames: z.array(z.string()),
  origin: z.enum(["authored", "framework"]),
  slug: z.string(),
});
const skill = entry.extend({
  description: z.string(),
  license: z.string().optional(),
  markdown: z.string(),
  metadata: z.record(z.string(), z.string()).optional(),
});
const instructions = entry.extend({
  content: z.string(),
  role: z.enum(["system", "user"]),
});
const schedule = entry.extend({
  cron: z.string(),
  hasRun: z.boolean(),
  markdown: z.string().optional(),
});
const subagent = entry.extend({
  description: z.string().optional(),
  entryPath: z.string(),
  nodeId: z.string(),
  rootPath: z.string(),
  summary: z.object({
    channels: z.number(),
    connections: z.number(),
    hooks: z.number(),
    instructions: z.boolean(),
    schedules: z.number(),
    skills: z.number(),
    tools: z.number(),
  }),
});
const channel = entry.extend({
  adapterKind: z.string().optional(),
  method: z.string(),
  origin: z.enum(["authored", "framework"]),
  urlPath: z.string(),
});
const frameworkChannel = channel.extend({
  disabledByAuthor: z.boolean(),
  replacedByAuthoredChannel: z.boolean(),
  status: z.enum(["active", "disabled", "replaced"]),
});
const connection = source.extend({
  connectionName: z.string(),
  description: z.string(),
  hasApproval: z.boolean(),
  hasAuthorization: z.boolean(),
  hasHeaders: z.boolean(),
  protocol: z.string(),
  toolFilter: z.unknown().optional(),
  url: z.string(),
});
const hook = source.extend({
  eventNames: z.array(z.string()),
  slug: z.string(),
});
const sandbox = source.extend({
  backendKind: z.string().optional(),
  description: z.string().optional(),
  hasBootstrap: z.boolean(),
  hasOnSession: z.boolean(),
  revalidationKey: z.string().optional(),
  sourceHash: z.string().optional(),
});
const AgentInfoResultSchema = z.object({
  agent: z.object({
    agentRoot: z.string(),
    appRoot: z.string(),
    configSource: source.optional(),
    description: z.string().optional(),
    model: agentModel,
    name: z.string(),
    outputSchema: z.unknown().optional(),
  }),
  capabilities: z.object({ devRoutes: z.boolean() }),
  channels: z.object({
    authored: z.array(channel),
    available: z.array(channel),
    disabledFramework: z.array(z.string()),
    framework: z.array(frameworkChannel),
  }),
  connections: z.array(connection),
  diagnostics: z.object({
    discoveryErrors: z.number(),
    discoveryWarnings: z.number(),
  }),
  hooks: z.array(hook),
  instructions: z.object({
    dynamic: z.array(dynamicResolver),
    static: z.array(instructions),
  }),
  kind: z.literal("eve-agent-info"),
  mode: z.enum(["development", "production"]),
  sandbox: sandbox.nullable(),
  schedules: z.array(schedule),
  skills: z.object({
    dynamic: z.array(dynamicResolver),
    static: z.array(skill),
  }),
  subagents: z.object({
    local: z.array(subagent),
    total: z.number(),
  }),
  tools: z.object({
    authored: z.array(tool),
    available: z.array(tool),
    disabledFramework: z.array(z.string()),
    dynamic: z.array(dynamicResolver),
    framework: z.array(frameworkTool),
    reserved: z.array(z.string()),
  }),
  version: z.literal(2),
  workflow: z.object({
    enabled: z.boolean(),
    toolName: z.string(),
  }),
  workspace: z.object({
    resourceRoot: z.unknown(),
    rootEntries: z.array(z.string()),
  }),
});

//#endregion
//#region src/shared/guards.ts
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

//#endregion
//#region src/client/client-error.ts
var ClientError = class extends Error {
  code;
  status;
  body;
  headers;
  constructor(status, body, headers) {
    let message = body || `Server returned ${status}.`;
    let code;
    try {
      const parsed = JSON.parse(body);
      if (isObject(parsed)) {
        if (typeof parsed.error === "string") message = parsed.error;
        if (typeof parsed.code === "string") code = parsed.code;
      }
    } catch {}
    super(message);
    this.name = "ClientError";
    this.code = code;
    this.status = status;
    this.body = body;
    this.headers = Object.freeze(
      Object.fromEntries(new Headers(headers).entries()),
    );
  }
};

//#endregion
//#region src/shared/errors.ts
function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null || error === void 0) return String(error);
  if (isObject(error)) {
    if (typeof error.message === "string" && error.message.length > 0)
      return error.message;
    return safeJsonStringify(error);
  }
  return String(error);
}
function toError(raw) {
  if (raw instanceof Error) return raw;
  const error = new Error(toErrorMessage(raw));
  if (!isObject(raw)) return error;
  if (typeof raw.name === "string" && raw.name.length > 0)
    error.name = raw.name;
  if (typeof raw.stack === "string" && raw.stack.length > 0)
    error.stack = raw.stack;
  if ("cause" in raw && raw.cause !== void 0 && raw.cause !== raw)
    error.cause = raw.cause;
  return error;
}
function safeJsonStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

//#endregion
//#region src/shared/ulid.ts
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const TIME_MAX = 2 ** 48 - 1;
const RANDOM_BYTES = 10;
function createUlidFactory() {
  let lastTimeMs = -1;
  const lastRandom = new Uint8Array(RANDOM_BYTES);
  return function createUlidFromFactory() {
    const now = Date.now();
    if (!Number.isInteger(now) || now < 0 || now > TIME_MAX)
      throw new Error(
        `Cannot mint a ULID: timestamp must be an integer from 0 to ${TIME_MAX}.`,
      );
    if (now > lastTimeMs) {
      lastTimeMs = now;
      randomFill(lastRandom);
    } else if (!incrementRandom(lastRandom)) {
      if (lastTimeMs === TIME_MAX)
        throw new Error(
          "Cannot mint a ULID: random component overflowed at the maximum timestamp.",
        );
      lastTimeMs += 1;
      randomFill(lastRandom);
    }
    return `${encodeTime(lastTimeMs)}${encodeRandom(lastRandom)}`;
  };
}
const createUlid = createUlidFactory();
function randomFill(target) {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues !== "function")
    throw new Error(
      "Cannot mint a ULID: globalThis.crypto.getRandomValues is unavailable.",
    );
  webCrypto.getRandomValues(target);
}
function encodeTime(timeMs) {
  let remaining = timeMs;
  let encoded = "";
  for (let index = 0; index < TIME_CHARS; index += 1) {
    encoded = ENCODING[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}
function encodeRandom(bytes) {
  let buffer = 0;
  let bufferedBits = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;
    while (bufferedBits >= 5) {
      bufferedBits -= 5;
      encoded += ENCODING[(buffer >>> bufferedBits) & 31];
    }
    buffer &= (1 << bufferedBits) - 1;
  }
  return encoded;
}
function incrementRandom(bytes) {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 255) {
      bytes[index] = byte + 1;
      bytes.fill(0, index + 1);
      return true;
    }
  }
  return false;
}

//#endregion
//#region src/protocol/message.ts
const EVE_SESSION_ID_HEADER = "x-eve-session-id";
const EVE_STREAM_TAIL_INDEX_HEADER = "x-eve-stream-tail-index";
const textEncoder = new TextEncoder();
function isCurrentTurnBoundaryEvent(event) {
  return (
    event.type === "session.completed" ||
    event.type === "session.failed" ||
    event.type === "session.waiting"
  );
}
function isTurnFailureEvent(event) {
  return (
    event.type === "session.failed" ||
    event.type === "step.failed" ||
    event.type === "turn.failed"
  );
}

//#endregion
//#region src/client/output-schema.ts
function extractCompletedResult(events) {
  let result;
  for (const event of events)
    if (isResultCompletedEvent(event)) result = event.data.result;
  return result;
}
function isResultCompletedEvent(event) {
  return event.type === "result.completed";
}

//#endregion
//#region src/client/session-utils.ts
function summarizeTurnEvents(events) {
  let boundary;
  let failure;
  let message;
  const inputRequests = [];
  const pendingAuthorizations = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (isCurrentTurnBoundaryEvent(event)) boundary = event;
    if (isTurnFailureEvent(event)) failure = event;
    if (isFinalMessageCompleted(event)) message = event.data.message ?? void 0;
    if (event.type === "input.requested")
      inputRequests.push(...event.data.requests);
    if (event.type === "authorization.required")
      pendingAuthorizations.set(event.data.name, event.data);
    if (event.type === "authorization.completed")
      pendingAuthorizations.delete(event.data.name);
  }
  return {
    boundary,
    failure,
    inputRequests,
    message,
    pendingAuthorizations: [...pendingAuthorizations.values()],
    status:
      boundary?.type === "session.waiting"
        ? "waiting"
        : boundary?.type === "session.failed"
          ? "failed"
          : "completed",
  };
}
function isFinalMessageCompleted(event) {
  return (
    event.type === "message.completed" &&
    event.data.finishReason !== "tool-calls"
  );
}

//#endregion
//#region src/client/message-response.ts
var MessageResponse = class {
  sessionId;
  #cancelTurn;
  #cancellation;
  #consumed = false;
  #createStream;
  #settled = false;
  #turnId = Promise.withResolvers();
  constructor(input) {
    this.#cancelTurn = input.cancelTurn;
    this.sessionId = input.sessionId;
    this.#createStream = input.createStream;
  }
  cancel() {
    if (this.#settled) return Promise.resolve({ status: "no_active_turn" });
    if (this.#cancellation !== void 0) return this.#cancellation;
    const cancellation = this.#turnId.promise.then((turnId) =>
      turnId === void 0
        ? { status: "no_active_turn" }
        : this.#cancelTurn(turnId),
    );
    this.#cancellation = cancellation;
    cancellation.catch(() => {
      if (!this.#settled && this.#cancellation === cancellation)
        this.#cancellation = void 0;
    });
    return cancellation;
  }
  async result() {
    const events = [];
    for await (const event of this) events.push(event);
    const summary = summarizeTurnEvents(events);
    return {
      data: extractCompletedResult(events),
      events,
      inputRequests: summary.inputRequests,
      message: summary.message,
      sessionId: this.sessionId,
      status: summary.status,
    };
  }
  [Symbol.asyncIterator]() {
    if (this.#consumed)
      throw new Error("MessageResponse has already been consumed.");
    this.#consumed = true;
    return this.#observeStream();
  }
  async *#observeStream() {
    try {
      for await (const event of this.#createStream()) {
        if (event.type === "turn.started")
          this.#turnId.resolve(event.data.turnId);
        else if (isCurrentTurnBoundaryEvent(event)) {
          this.#settled = true;
          this.#turnId.resolve(void 0);
        }
        yield event;
      }
    } finally {
      this.#turnId.resolve(void 0);
    }
  }
};

//#endregion
//#region src/client/ndjson.ts
function isStreamDisconnectError(error) {
  if (error instanceof DOMException) return error.name === "AbortError";
  if (!(error instanceof Error)) return false;
  const errorCode =
    "code" in error && typeof error.code === "string" ? error.code : void 0;
  return (
    error.name === "AbortError" ||
    error.message === "terminated" ||
    errorCode === "UND_ERR_SOCKET" ||
    (error instanceof TypeError &&
      /^(?:failed to fetch|fetch failed)$/i.test(error.message)) ||
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(
      error.message,
    )
  );
}
async function* readNdjsonStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        reachedEof = true;
        buffer += decoder.decode();
        break;
      }
      if (result.value)
        buffer += decoder.decode(result.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) yield JSON.parse(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    const trailing = buffer.trim();
    if (trailing.length > 0) yield JSON.parse(trailing);
  } finally {
    if (!reachedEof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

//#endregion
//#region src/client/url.ts
function createClientUrl(host, routePath, searchParams) {
  const queryIndex = routePath.indexOf("?");
  const pathOnly =
    queryIndex === -1 ? routePath : routePath.slice(0, queryIndex);
  const embeddedQuery =
    queryIndex === -1 ? "" : routePath.slice(queryIndex + 1);
  const normalizedRoute = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  if (isAbsoluteUrl(host)) {
    const url = new URL(host);
    url.pathname = `${trimTrailingSlash(url.pathname)}${normalizedRoute}`;
    mergeEmbeddedQuery(url.searchParams, embeddedQuery);
    mergeSearchParams(url.searchParams, searchParams);
    url.hash = "";
    return url.toString();
  }
  const url = new URL(host, "http://eve.local");
  const basePath = trimTrailingSlash(url.pathname);
  mergeEmbeddedQuery(url.searchParams, embeddedQuery);
  mergeSearchParams(url.searchParams, searchParams);
  return `${basePath}${normalizedRoute}${formatSearch(url.searchParams)}`;
}
function mergeEmbeddedQuery(target, embeddedQuery) {
  if (embeddedQuery.length === 0) return;
  for (const [name, value] of new URLSearchParams(embeddedQuery))
    target.append(name, value);
}
function isAbsoluteUrl(value) {
  return /^[a-z][a-z\d+\-.]*:/i.test(value);
}
function trimTrailingSlash(value) {
  if (value === "/") return "";
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
function mergeSearchParams(target, searchParams) {
  if (searchParams === void 0) return;
  for (const [name, value] of Object.entries(searchParams))
    target.set(name, value);
}
function formatSearch(searchParams) {
  const value = searchParams.toString();
  return value.length === 0 ? "" : `?${value}`;
}

//#endregion
//#region src/client/open-stream.ts
const DEFAULT_STREAM_RECONNECT_POLICY = {
  retryableErrorStatuses: /* @__PURE__ */ new Set([
    404, 409, 425, 500, 502, 503, 504,
  ]),
  streamIdleReconnectPolicy: {
    baseDelayMs: 250,
    maxAttempts: 5,
    maxDelayMs: 4e3,
  },
  streamOpenReconnectPolicy: {
    baseDelayMs: 250,
    maxAttempts: 12,
    maxDelayMs: 5e3,
  },
};
const NO_STREAM_RECONNECT_POLICY = {
  ...DEFAULT_STREAM_RECONNECT_POLICY,
  streamIdleReconnectPolicy: {
    ...DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy,
    maxAttempts: 0,
  },
  streamOpenReconnectPolicy: {
    ...DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy,
    maxAttempts: 1,
  },
};
function resolveRetryPolicy(policy, defaults) {
  return {
    ...defaults,
    ...policy,
  };
}
function resolveStreamReconnectPolicy(policy) {
  if (policy && "reconnect" in policy && policy.reconnect === false)
    return NO_STREAM_RECONNECT_POLICY;
  const configured = policy;
  return {
    retryableErrorStatuses: configured?.retryableErrorStatuses
      ? new Set(configured.retryableErrorStatuses)
      : DEFAULT_STREAM_RECONNECT_POLICY.retryableErrorStatuses,
    streamIdleReconnectPolicy: resolveRetryPolicy(
      configured?.streamIdleReconnectPolicy,
      DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy,
    ),
    streamOpenReconnectPolicy: resolveRetryPolicy(
      configured?.streamOpenReconnectPolicy,
      DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy,
    ),
  };
}
async function* followStreamIterable(input) {
  if (input.follow === false && input.startIndex < 0)
    throw new Error(
      "stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.",
    );
  const retryPolicy = resolveStreamReconnectPolicy(input.streamReconnectPolicy);
  const idleRetryPolicy = retryPolicy.streamIdleReconnectPolicy;
  let startIndex = input.startIndex;
  let reconnectDelayMs = idleRetryPolicy.baseDelayMs;
  let idleReconnects = 0;
  let initialConnection = true;
  let tailIndex;
  while (true) {
    let connection;
    try {
      connection = await openStreamBody({
        ...input,
        retryPolicy,
        startIndex,
        requestTailIndex: input.follow === false && tailIndex === void 0,
      });
    } catch (error) {
      if (input.signal?.aborted) return;
      throw error;
    }
    if (input.follow === false && tailIndex === void 0) {
      tailIndex = connection.tailIndex;
      if (tailIndex === void 0) {
        await connection.body.cancel().catch(() => {});
        throw new Error(
          `stream({ follow: false }) requires the server to report the ${EVE_STREAM_TAIL_INDEX_HEADER} header. The agent may be running an older eve version.`,
        );
      }
    }
    if (tailIndex !== void 0 && startIndex > tailIndex) {
      await connection.body.cancel().catch(() => {});
      return;
    }
    let deliveredEvent = false;
    try {
      for await (const event of readNdjsonStream(connection.body)) {
        startIndex += 1;
        deliveredEvent = true;
        reconnectDelayMs = idleRetryPolicy.baseDelayMs;
        idleReconnects = 0;
        yield event;
        if (tailIndex !== void 0 && startIndex > tailIndex) return;
      }
    } catch (error) {
      if (!isStreamDisconnectError(error)) throw error;
    }
    if (
      input.signal?.aborted ||
      input.startIndex < 0 ||
      idleRetryPolicy.maxAttempts === 0
    )
      return;
    if (
      input.keepAlive !== true &&
      !deliveredEvent &&
      !initialConnection &&
      (idleReconnects += 1) >= idleRetryPolicy.maxAttempts
    )
      return;
    initialConnection = false;
    await sleep(reconnectDelayMs, input.signal);
    if (input.signal?.aborted) return;
    reconnectDelayMs = Math.min(
      reconnectDelayMs * 2,
      idleRetryPolicy.maxDelayMs,
    );
  }
}
async function openStreamBody(input) {
  const retryPolicy = input.retryPolicy ?? DEFAULT_STREAM_RECONNECT_POLICY;
  const openRetryPolicy = retryPolicy.streamOpenReconnectPolicy;
  let lastStatus;
  let lastBody;
  let lastHeaders;
  let retryDelayMs = openRetryPolicy.baseDelayMs;
  const searchParams = {};
  if (input.startIndex !== 0)
    searchParams.startIndex = String(input.startIndex);
  if (input.requestTailIndex === true) searchParams.includeTailIndex = "1";
  for (let attempt = 0; attempt < openRetryPolicy.maxAttempts; attempt += 1) {
    const url = createClientUrl(
      input.host,
      createEveSessionStreamRoutePath(input.sessionId),
      Object.keys(searchParams).length > 0 ? searchParams : void 0,
    );
    const headers = await input.resolveHeaders();
    let response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        headers,
        redirect: input.redirect,
        signal: input.signal ?? null,
      });
    } catch (error) {
      if (
        input.signal?.aborted ||
        !isStreamDisconnectError(error) ||
        attempt === openRetryPolicy.maxAttempts - 1
      )
        throw error;
      await sleep(retryDelayMs, input.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, openRetryPolicy.maxDelayMs);
      continue;
    }
    if (response.ok) {
      if (!response.body)
        throw new ClientError(
          response.status,
          "Response body is null.",
          response.headers,
        );
      return {
        body: response.body,
        tailIndex: parseTailIndexHeader(response.headers),
      };
    }
    lastStatus = response.status;
    lastBody = await response.text();
    lastHeaders = response.headers;
    if (!retryPolicy.retryableErrorStatuses.has(response.status))
      throw new ClientError(response.status, lastBody, response.headers);
    if (attempt < openRetryPolicy.maxAttempts - 1) {
      await sleep(retryDelayMs, input.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, openRetryPolicy.maxDelayMs);
    }
  }
  throw new ClientError(
    lastStatus ?? 0,
    lastBody ?? "Failed to open message stream.",
    lastHeaders,
  );
}
function parseTailIndexHeader(headers) {
  const raw = headers.get(EVE_STREAM_TAIL_INDEX_HEADER);
  if (raw === null || !/^-?\d+$/.test(raw)) return;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : void 0;
}
async function sleep(ms, signal) {
  if (signal?.aborted) return;
  await new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

//#endregion
//#region src/protocol/cancel-turn.ts
const CancelTurnResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ok: z.literal(true),
    sessionId: z.string().min(1),
    status: z.literal("accepted"),
  }),
  z.strictObject({
    ok: z.literal(true),
    status: z.literal("no_active_turn"),
  }),
]);

//#endregion
//#region src/protocol/clear-session.ts
const ClearResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    sessionId: z.string().min(1),
    status: z.literal("accepted"),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal("no_active_session"),
  }),
]);

//#endregion
//#region src/protocol/compact-session.ts
const CompactResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    sessionId: z.string().min(1),
    status: z.literal("accepted"),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal("no_active_session"),
  }),
]);

//#endregion
//#region src/protocol/reset-session.ts
const ResetResponseSchema = z.discriminatedUnion("status", [
  z.object({
    ok: z.literal(true),
    previousSessionId: z.string().min(1),
    status: z.literal("reset"),
  }),
  z.object({
    ok: z.literal(true),
    status: z.literal("no_active_session"),
  }),
]);

//#endregion
//#region src/client/session-controls.ts
async function cancelClientSession(input) {
  const { payload, response } = await postJson({
    body: input.options,
    context: input.context,
    operation: "Cancel",
    path: createEveSessionCancelRoutePath(input.sessionId),
  });
  const result = CancelTurnResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "accepted" &&
      result.data.sessionId !== input.sessionId)
  )
    throw new Error(
      `Cancel route returned an invalid response (${response.status}).`,
    );
  return result.data.status === "accepted"
    ? {
        sessionId: result.data.sessionId,
        status: "accepted",
      }
    : { status: "no_active_turn" };
}
async function clearClientSession(input) {
  const { payload } = await postJson({
    context: input.context,
    operation: "Clear",
    path: createEveSessionClearRoutePath(input.sessionId),
  });
  const result = ClearResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "accepted" &&
      result.data.sessionId !== input.sessionId)
  )
    throw new Error("Clear route returned an invalid response.");
  return result.data.status === "accepted"
    ? {
        sessionId: result.data.sessionId,
        status: "accepted",
      }
    : { status: "no_active_session" };
}
async function compactClientSession(input) {
  const { payload } = await postJson({
    context: input.context,
    operation: "Compact",
    path: createEveSessionCompactRoutePath(input.sessionId),
  });
  const result = CompactResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "accepted" &&
      result.data.sessionId !== input.sessionId)
  )
    throw new Error("Compact route returned an invalid response.");
  return result.data.status === "accepted"
    ? {
        sessionId: result.data.sessionId,
        status: "accepted",
      }
    : { status: "no_active_session" };
}
async function resetClientSession(input) {
  const { payload } = await postJson({
    body: input.options,
    context: input.context,
    operation: "Reset",
    path: createEveSessionResetRoutePath(input.sessionId),
  });
  const result = ResetResponseSchema.safeParse(payload);
  if (
    !result.success ||
    (result.data.status === "reset" &&
      result.data.previousSessionId !== input.sessionId)
  )
    throw new Error("Reset route returned an invalid response.");
  return result.data.status === "reset"
    ? {
        previousSessionId: result.data.previousSessionId,
        status: "reset",
      }
    : { status: "no_active_session" };
}
async function postJson(input) {
  const headers = await input.context.resolveHeaders();
  headers.set("content-type", "application/json");
  const response = await fetch(
    createClientUrl(input.context.host, input.path),
    withRedirectPolicy$1(
      {
        body: input.body === void 0 ? void 0 : JSON.stringify(input.body),
        headers,
        method: "POST",
      },
      input.context.redirect,
    ),
  );
  const text = await response.text();
  if (!response.ok)
    throw new ClientError(response.status, text, response.headers);
  try {
    return {
      payload: JSON.parse(text),
      response,
    };
  } catch {
    throw new Error(
      `${input.operation} route returned invalid JSON (${response.status}).`,
    );
  }
}
function withRedirectPolicy$1(init, redirect) {
  return redirect === void 0
    ? init
    : {
        ...init,
        redirect,
      };
}

//#endregion
//#region src/shared/json.ts
const INVALID_JSON_VALUE_CANDIDATE = Symbol("invalid-json-value-candidate");
const JSON_VALUE_ERROR_MESSAGE = "Expected a JSON-serializable value.";
const JSON_OBJECT_ERROR_MESSAGE = "Expected a JSON-serializable object.";
function parseJsonValue(value) {
  const normalized = normalizeJsonValueCandidate(value);
  if (normalized === INVALID_JSON_VALUE_CANDIDATE)
    throw new TypeError(JSON_VALUE_ERROR_MESSAGE);
  return normalized;
}
function parseJsonObject(value) {
  const normalized = parseJsonValue(value);
  if (!isJsonObjectValue(normalized))
    throw new TypeError(JSON_OBJECT_ERROR_MESSAGE);
  return normalized;
}
function normalizeJsonValueCandidate(
  value,
  seen = /* @__PURE__ */ new WeakSet(),
) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : INVALID_JSON_VALUE_CANDIDATE;
  if (Array.isArray(value)) {
    const normalizedItems = [];
    for (const item of value) {
      const normalizedItem = normalizeJsonValueCandidate(item, seen);
      if (normalizedItem === INVALID_JSON_VALUE_CANDIDATE)
        return INVALID_JSON_VALUE_CANDIDATE;
      normalizedItems.push(normalizedItem);
    }
    return normalizedItems;
  }
  if (typeof value !== "object" || value === void 0)
    return INVALID_JSON_VALUE_CANDIDATE;
  if (!isPlainObject(value)) return INVALID_JSON_VALUE_CANDIDATE;
  if (seen.has(value)) return INVALID_JSON_VALUE_CANDIDATE;
  seen.add(value);
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === void 0) continue;
    const normalizedEntry = normalizeJsonValueCandidate(entry, seen);
    if (normalizedEntry === INVALID_JSON_VALUE_CANDIDATE)
      return INVALID_JSON_VALUE_CANDIDATE;
    normalized[key] = normalizedEntry;
  }
  seen.delete(value);
  return normalized;
}
function isJsonObjectValue(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

//#endregion
//#region src/shared/tool-schema.ts
const JSON_SCHEMA_TARGET = "draft-07";
function serializeOutputSchema(source) {
  return serializeSchema(source, "output");
}
const UNSPECIFIED_INPUT_SCHEMA = z.fromJSONSchema({});
function serializeSchema(source, direction) {
  if (source === null || source === void 0) return source;
  return toJsonObject(source, direction);
}
function toJsonObject(source, direction) {
  const standard = getStandardSchemaProperties(source);
  const jsonSchema = standard?.jsonSchema;
  const emit =
    typeof jsonSchema === "object" && jsonSchema !== null
      ? jsonSchema[direction]
      : void 0;
  const vendor =
    typeof standard?.vendor === "string" ? standard.vendor : "unknown";
  if (standard !== void 0 && typeof emit !== "function" && vendor === "zod") {
    if (direction === "input") {
      const { $schema: _schemaVersion, ...canonical } = parseJsonObject(
        asSchema(source).jsonSchema,
      );
      return canonical;
    }
    throw new Error(
      "Zod 3 cannot emit an output JSON Schema. Upgrade to Zod 4 or provide a plain JSON Schema object.",
    );
  }
  if (standard !== void 0 && typeof emit !== "function")
    throw new Error(
      `Standard Schema vendor "${vendor}" does not support JSON Schema conversion. Provide a Standard Schema implementation with JSON Schema conversion or a plain JSON Schema object.`,
    );
  const { $schema: _schemaVersion, ...canonical } =
    standard === void 0
      ? parseJsonObject(source)
      : parseJsonObject(emit({ target: JSON_SCHEMA_TARGET }));
  return canonical;
}
function getStandardSchemaProperties(value) {
  if (typeof value !== "object" || value === null || !("~standard" in value))
    return void 0;
  const standard = value["~standard"];
  return typeof standard === "object" && standard !== null ? standard : void 0;
}

//#endregion
//#region src/client/session.ts
var ClientSession = class ClientSession {
  #context;
  #state;
  constructor(context, state) {
    this.#context = context;
    this.#state = state;
  }
  static async create(context, input) {
    const response = await postTurn(
      context,
      EVE_SESSION_ROUTE_PATH,
      input,
      true,
    );
    const sessionId = await readSessionId(response);
    const session = new ClientSession(context, {
      sessionId,
      streamIndex: 0,
    });
    return {
      response: session.#messageResponse(response, input, 0),
      session,
    };
  }
  get state() {
    return this.#state;
  }
  async snapshot(options) {
    options?.signal?.throwIfAborted();
    const events = [];
    for await (const event of this.#readStream({
      follow: false,
      signal: options?.signal,
      startIndex: 0,
    }))
      events.push(event);
    options?.signal?.throwIfAborted();
    return {
      events,
      session: {
        sessionId: this.#state.sessionId,
        streamIndex: events.length,
      },
    };
  }
  async send(message, options = {}) {
    return await this.#send({
      ...options,
      message,
    });
  }
  async respond(inputResponses, options = {}) {
    if (inputResponses.length === 0)
      throw new Error(
        "ClientSession.respond() requires at least one input response.",
      );
    return await this.#send({
      ...options,
      inputResponses,
    });
  }
  async #send(input) {
    const initialStreamIndex = this.#state.streamIndex;
    const response = await postTurn(
      this.#context,
      createEveSessionRoutePath(this.#state.sessionId),
      input,
      false,
    );
    if (
      (await readSessionId(response, this.#state.sessionId)) !==
      this.#state.sessionId
    )
      throw new Error("Message route returned a different session id.");
    return this.#messageResponse(response, input, initialStreamIndex);
  }
  async cancel(options) {
    return await cancelClientSession({
      context: this.#context,
      options,
      sessionId: this.#state.sessionId,
    });
  }
  async clear() {
    return await clearClientSession({
      context: this.#context,
      sessionId: this.#state.sessionId,
    });
  }
  async compact() {
    return await compactClientSession({
      context: this.#context,
      sessionId: this.#state.sessionId,
    });
  }
  async reset(options) {
    return await resetClientSession({
      context: this.#context,
      options,
      sessionId: this.#state.sessionId,
    });
  }
  stream(options) {
    if (
      options?.follow === false &&
      (options.startIndex ?? this.#state.streamIndex) < 0
    )
      throw new Error(
        "stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.",
      );
    return this.#streamAndAdvance(options);
  }
  #messageResponse(response, input, initialStreamIndex) {
    response.body?.cancel().catch(() => {});
    return new MessageResponse({
      cancelTurn: async (turnId) => await this.cancel({ turnId }),
      createStream: () => this.#createEventStream(initialStreamIndex, input),
      sessionId: this.#state.sessionId,
    });
  }
  async *#createEventStream(initialStreamIndex, input) {
    let eventCount = 0;
    try {
      for await (const event of this.#readStream({
        headers: input.headers,
        keepAlive: shouldKeepActiveTurnAlive(input.streamReconnectPolicy),
        signal: input.signal,
        startIndex: initialStreamIndex,
        streamReconnectPolicy: input.streamReconnectPolicy,
      })) {
        eventCount += 1;
        yield event;
        if (isCurrentTurnBoundaryEvent(event)) break;
      }
    } finally {
      this.#state = {
        sessionId: this.#state.sessionId,
        streamIndex: initialStreamIndex + eventCount,
      };
    }
  }
  async *#streamAndAdvance(options) {
    const startIndex = options?.startIndex ?? this.#state.streamIndex;
    let eventCount = 0;
    try {
      for await (const event of this.#readStream({
        follow: options?.follow,
        signal: options?.signal,
        startIndex,
        streamReconnectPolicy: options?.streamReconnectPolicy,
      })) {
        eventCount += 1;
        yield event;
      }
    } finally {
      if (startIndex >= 0)
        this.#state = {
          sessionId: this.#state.sessionId,
          streamIndex: startIndex + eventCount,
        };
    }
  }
  #readStream(input) {
    return followStreamIterable({
      follow: input.follow,
      host: this.#context.host,
      keepAlive: input.keepAlive,
      resolveHeaders: () => this.#context.resolveHeaders(input.headers),
      redirect: this.#context.redirect,
      sessionId: this.#state.sessionId,
      signal: input.signal,
      startIndex: input.startIndex,
      streamReconnectPolicy: input.streamReconnectPolicy,
    });
  }
};
function shouldKeepActiveTurnAlive(policy) {
  if (policy && "reconnect" in policy) return false;
  return policy?.streamIdleReconnectPolicy?.maxAttempts === void 0;
}
async function postTurn(context, path, input, requireMessage) {
  const body = createMessageBody(input, requireMessage);
  if (body === null)
    throw new Error(
      requireMessage
        ? "Creating a session requires a non-empty message."
        : "A session turn requires a non-empty message or inputResponses.",
    );
  const headers = await context.resolveHeaders(input.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(createClientUrl(context.host, path), {
    body: JSON.stringify(body),
    headers,
    method: "POST",
    redirect: context.redirect,
    signal: input.signal ?? null,
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new ClientError(response.status, responseBody, response.headers);
  }
  return response;
}
async function readSessionId(response, expected) {
  const payload = await response.json();
  const sessionId =
    (typeof payload.sessionId === "string" ? payload.sessionId : void 0) ??
    response.headers.get("x-eve-session-id")?.trim() ??
    expected;
  if (!sessionId) throw new Error("Message route did not return a session id.");
  return sessionId;
}
function createMessageBody(input, requireMessage) {
  const body = {};
  if (input.message !== void 0) body.message = input.message;
  if (input.inputResponses !== void 0 && input.inputResponses.length > 0)
    body.inputResponses = input.inputResponses;
  if (
    !requireMessage &&
    input.message !== void 0 &&
    input.turnPolicy !== void 0
  )
    body.turnPolicy = input.turnPolicy;
  if (input.clientContext !== void 0) body.clientContext = input.clientContext;
  const outputSchema = serializeOutputSchema(input.outputSchema);
  if (outputSchema !== void 0) body.outputSchema = outputSchema;
  if (requireMessage && body.message === void 0) return null;
  if (body.message === void 0 && body.inputResponses === void 0) return null;
  return body;
}

//#endregion
//#region src/client/sessions.ts
var ClientSessions = class {
  #context;
  constructor(context) {
    this.#context = context;
  }
  async create(input) {
    return await ClientSession.create(this.#context, input);
  }
  attach(sessionId, options) {
    if (sessionId.length === 0)
      throw new Error("sessionId must be a non-empty string.");
    return new ClientSession(this.#context, {
      sessionId,
      streamIndex: options?.streamIndex ?? 0,
    });
  }
};

//#endregion
//#region src/client/types.ts
const VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER = "x-vercel-trusted-oidc-idp-token";

//#endregion
//#region src/client/client.ts
var Client = class {
  #auth;
  #headers;
  #host;
  #redirect;
  sessions;
  constructor(options) {
    this.#host = options.host;
    this.#auth = options.auth;
    this.#headers = options.headers;
    this.#redirect = options.redirect;
    this.sessions = new ClientSessions({
      host: this.#host,
      redirect: this.#redirect,
      resolveHeaders: (perRequest) => this.#resolveHeaders(perRequest),
    });
  }
  async health() {
    const url = createClientUrl(this.#host, EVE_HEALTH_ROUTE_PATH);
    const headers = await this.#resolveHeaders();
    const response = await fetch(
      url,
      withRedirectPolicy({ headers }, this.#redirect),
    );
    if (!response.ok) {
      const body = await response.text();
      throw new ClientError(response.status, body, response.headers);
    }
    return await response.json();
  }
  async info() {
    const response = await this.fetch(EVE_INFO_ROUTE_PATH);
    if (!response.ok) {
      const body = await response.text();
      throw new ClientError(response.status, body, response.headers);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new AgentInfoResponseError();
    }
    const result = AgentInfoResultSchema.safeParse(payload);
    if (!result.success)
      throw new AgentInfoResponseError(
        result.error.issues.slice(0, 5).map((issue) => {
          const path = issue.path.join(".");
          return path.length === 0
            ? issue.message
            : `${path}: ${issue.message}`;
        }),
      );
    return result.data;
  }
  async fetch(path, init = {}) {
    const url = createClientUrl(this.#host, path);
    const headers = await this.#resolveHeaders(
      headersInitToRecord(init.headers),
    );
    return await fetch(
      url,
      withRedirectPolicy(
        {
          ...init,
          headers,
        },
        this.#redirect,
      ),
    );
  }
  async #resolveHeaders(perRequest) {
    const headers = new Headers();
    const [baseHeaders, authHeaders] = await Promise.all([
      resolveHeadersValue(this.#headers),
      this.#resolveAuthHeaders(),
    ]);
    for (const [key, value] of Object.entries(baseHeaders))
      headers.set(key, value);
    for (const [key, value] of Object.entries(authHeaders))
      headers.set(key, value);
    if (perRequest)
      for (const [key, value] of Object.entries(perRequest))
        headers.set(key, value);
    return headers;
  }
  async #resolveAuthHeaders() {
    const auth = this.#auth;
    if (!auth) return {};
    if ("vercelOidc" in auth) {
      const token = (await resolveTokenValue(auth.vercelOidc.token)).trim();
      if (token.length === 0) return {};
      return {
        authorization: `Bearer ${token}`,
        [VERCEL_TRUSTED_OIDC_IDP_TOKEN_HEADER]: token,
      };
    }
    if ("bearer" in auth) {
      const token = (await resolveTokenValue(auth.bearer)).trim();
      return token.length === 0 ? {} : { authorization: `Bearer ${token}` };
    }
    if ("basic" in auth) {
      const password = await resolveTokenValue(auth.basic.password);
      return {
        authorization: `Basic ${encodeBasicCredentials(auth.basic.username, password)}`,
      };
    }
    return {};
  }
};
async function resolveTokenValue(value) {
  return typeof value === "function" ? value() : value;
}
async function resolveHeadersValue(value) {
  if (value === void 0) return {};
  return typeof value === "function" ? await value() : value;
}
function headersInitToRecord(headers) {
  if (headers === void 0) return {};
  return Object.fromEntries(new Headers(headers).entries());
}
function withRedirectPolicy(init, redirect) {
  return redirect === void 0
    ? init
    : {
        ...init,
        redirect,
      };
}

//#endregion
//#region src/protocol/event-dedupe.ts
function createEventDeduper() {
  const seen = /* @__PURE__ */ new Set();
  return {
    admit(event) {
      const id = event.meta?.id;
      if (id === void 0) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}

//#endregion
//#region src/client/eve-agent-store.ts
const detachStore = Symbol("detachEveAgentStore");
var EveAgentStore = class {
  #client;
  #externalSession;
  #optimistic;
  #reducer;
  #subscribers = /* @__PURE__ */ new Set();
  #seenEvents = createEventDeduper();
  #activeTurn;
  #callbacks = {};
  #data;
  #error;
  #events;
  #pendingMessageSubmission;
  #projectionEvents;
  #session;
  #snapshot;
  #status = "ready";
  constructor(init) {
    this.#externalSession = init.session !== void 0;
    this.#client = this.#externalSession
      ? void 0
      : new Client({
          auth: init.auth,
          headers: init.headers,
          host: init.host ?? "",
        });
    const initialEvents = [];
    for (const event of init.initialEvents ?? [])
      if (this.#seenEvents.admit(event)) initialEvents.push(event);
    this.#events = initialEvents;
    this.#projectionEvents = [...this.#events];
    this.#optimistic = init.optimistic ?? true;
    this.#reducer = init.reducer;
    this.#session =
      init.session ??
      (init.initialSession === void 0
        ? void 0
        : this.#client?.sessions.attach(init.initialSession.sessionId, {
            streamIndex: init.initialSession.streamIndex,
          }));
    this.#data = this.#reduceProjectionEvents(this.#projectionEvents);
    this.#snapshot = this.#createSnapshot();
  }
  get snapshot() {
    return this.#snapshot;
  }
  setCallbacks(callbacks) {
    this.#callbacks = callbacks;
  }
  subscribe(callback) {
    this.#subscribers.add(callback);
    return () => {
      this.#subscribers.delete(callback);
    };
  }
  async send(input) {
    if (this.#status === "streaming" || this.#status === "submitted")
      throw new Error("eve session is already processing a turn.");
    const response = Promise.withResolvers();
    const turn = {
      abortController: new AbortController(),
      response: response.promise,
      resolveResponse: response.resolve,
    };
    this.#activeTurn = turn;
    this.#error = void 0;
    this.#status = "submitted";
    this.#publish();
    try {
      const preparedInput =
        (await this.#callbacks.prepareSend?.(input)) ?? input;
      assertExclusiveTurnInput(preparedInput);
      if (!this.#isActiveTurn(turn)) return;
      this.#projectOptimisticMessage(preparedInput);
      this.#projectInputResponses(preparedInput);
      this.#publish();
      const turnInput = {
        ...preparedInput,
        signal: createAbortSignal(
          preparedInput.signal,
          turn.abortController.signal,
        ),
      };
      const response = await this.#dispatchTurn(turnInput);
      if (!this.#isActiveTurn(turn)) return;
      turn.resolveResponse(response);
      let sawEvent = false;
      for await (const event of response) {
        if (!this.#isActiveTurn(turn)) return;
        if (!sawEvent) {
          sawEvent = true;
          this.#status = "streaming";
        }
        if (!this.#seenEvents.admit(event)) continue;
        this.#events = [...this.#events, event];
        this.#applyServerEvent(event);
        this.#callbacks.onEvent?.(event);
        this.#applyTerminalStreamFailure(event);
        this.#publish();
      }
      if (!this.#isActiveTurn(turn)) return;
      this.#status = this.#error === void 0 ? "ready" : "error";
    } catch (error) {
      if (!this.#isActiveTurn(turn)) return;
      if (isAbortError(error)) {
        this.#status = "ready";
        this.#failPendingMessageSubmission(toError(error));
      } else {
        this.#error = toError(error);
        this.#status = "error";
        this.#failPendingMessageSubmission(this.#error);
        this.#callbacks.onError?.(this.#error);
      }
    } finally {
      if (this.#isActiveTurn(turn)) {
        turn.resolveResponse(void 0);
        this.#activeTurn = void 0;
        this.#callbacks.onSessionChange?.(this.#session?.state);
        this.#publish();
        this.#callbacks.onFinish?.(this.#snapshot);
      }
    }
  }
  cancel() {
    const turn = this.#activeTurn;
    if (turn === void 0) return Promise.resolve({ status: "no_active_turn" });
    return turn.response.then((response) =>
      response === void 0 ? { status: "no_active_turn" } : response.cancel(),
    );
  }
  [detachStore]() {
    this.#activeTurn?.abortController.abort();
  }
  reset() {
    const turn = this.#activeTurn;
    this.#activeTurn = void 0;
    turn?.resolveResponse(void 0);
    turn?.abortController.abort();
    if (!this.#externalSession) this.#session = void 0;
    this.#events = [];
    this.#seenEvents = createEventDeduper();
    this.#pendingMessageSubmission = void 0;
    this.#projectionEvents = [];
    this.#data = this.#reducer.initial();
    this.#error = void 0;
    this.#status = "ready";
    this.#callbacks.onSessionChange?.(this.#session?.state);
    this.#publish();
  }
  async #createFirstTurn(input) {
    if (this.#client === void 0)
      throw new Error("An external eve session is required before sending.");
    if (input.message === void 0)
      throw new Error(
        "Cannot answer an input request before the session starts.",
      );
    const created = await this.#client.sessions.create({
      ...input,
      message: input.message,
    });
    this.#session = created.session;
    this.#callbacks.onSessionChange?.(created.session.state);
    this.#publish();
    return created.response;
  }
  async #dispatchTurn(input) {
    if (this.#session === void 0) return await this.#createFirstTurn(input);
    if (input.inputResponses === void 0) {
      const { message, ...options } = input;
      return await this.#session.send(message, options);
    }
    const { inputResponses, ...options } = input;
    return await this.#session.respond(inputResponses, options);
  }
  #isActiveTurn(turn) {
    return this.#activeTurn === turn;
  }
  #projectOptimisticMessage(input) {
    if (!this.#optimistic || input.message === void 0) return;
    const id = createSubmissionId();
    const pending = {
      createdAt: Date.now(),
      id,
      message: summarizeUserContent(input.message),
    };
    this.#pendingMessageSubmission = pending;
    this.#appendProjectionEvent({
      data: {
        createdAt: pending.createdAt,
        message: pending.message,
        submissionId: pending.id,
      },
      type: "client.message.submitted",
    });
  }
  #projectInputResponses(input) {
    if (input.inputResponses === void 0 || input.inputResponses.length === 0)
      return;
    this.#appendProjectionEvent({
      data: {
        createdAt: Date.now(),
        responses: input.inputResponses,
      },
      type: "client.input.responded",
    });
  }
  #applyServerEvent(event) {
    if (
      event.type === "message.received" &&
      this.#pendingMessageSubmission !== void 0
    ) {
      const submissionId = this.#pendingMessageSubmission.id;
      this.#pendingMessageSubmission = void 0;
      this.#replaceProjectionEvent(
        (candidate) =>
          candidate.type === "client.message.submitted" &&
          candidate.data.submissionId === submissionId,
        event,
      );
      return;
    }
    this.#appendProjectionEvent(event);
  }
  #applyTerminalStreamFailure(event) {
    const error = toTerminalStreamFailureError(event);
    if (error === void 0) return;
    this.#status = "error";
    this.#failPendingMessageSubmission(error);
    if (this.#error === void 0) {
      this.#error = error;
      this.#callbacks.onError?.(error);
    }
  }
  #failPendingMessageSubmission(error) {
    const pending = this.#pendingMessageSubmission;
    if (pending === void 0) return;
    this.#pendingMessageSubmission = void 0;
    this.#replaceProjectionEvent(
      (event) =>
        event.type === "client.message.submitted" &&
        event.data.submissionId === pending.id,
      {
        data: {
          createdAt: pending.createdAt,
          error: { message: error.message },
          message: pending.message,
          submissionId: pending.id,
        },
        type: "client.message.failed",
      },
    );
  }
  #appendProjectionEvent(event) {
    this.#projectionEvents = [...this.#projectionEvents, event];
    this.#data = this.#reducer.reduce(this.#data, event);
  }
  #replaceProjectionEvent(predicate, replacement) {
    let replaced = false;
    this.#projectionEvents = this.#projectionEvents.map((event) => {
      if (!replaced && predicate(event)) {
        replaced = true;
        return replacement;
      }
      return event;
    });
    if (!replaced)
      this.#projectionEvents = [...this.#projectionEvents, replacement];
    this.#data = this.#reduceProjectionEvents(this.#projectionEvents);
  }
  #reduceProjectionEvents(events) {
    let data = this.#reducer.initial();
    for (const event of events) data = this.#reducer.reduce(data, event);
    return data;
  }
  #createSnapshot() {
    return {
      data: this.#data,
      error: this.#error,
      events: this.#events,
      session: this.#session?.state,
      status: this.#status,
    };
  }
  #publish() {
    this.#snapshot = this.#createSnapshot();
    for (const subscriber of this.#subscribers) subscriber();
  }
};
function detachEveAgentStore(store) {
  store[detachStore]();
}
function assertExclusiveTurnInput(input) {
  if ((input.message !== void 0) === (input.inputResponses !== void 0))
    throw new Error(
      "A turn requires exactly one of message or inputResponses.",
    );
}
let submissionSequence = 0;
function createSubmissionId() {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID !== void 0) return randomUUID.call(globalThis.crypto);
  submissionSequence += 1;
  return `submission_${submissionSequence.toString()}`;
}
function createAbortSignal(first, second) {
  return first ? AbortSignal.any([first, second]) : second;
}
function summarizeUserContent(message) {
  if (typeof message === "string") return message;
  const parts = [];
  for (const part of message) {
    if (part.type === "text") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "file")
      parts.push(part.filename ? `[file: ${part.filename}]` : "[file]");
  }
  return parts.join("\n");
}
function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}
function toTerminalStreamFailureError(event) {
  if (event.type !== "session.failed") return;
  const error = new Error(event.data.message);
  error.name = event.data.code;
  return error;
}

//#endregion
//#region src/client/agent-host.ts
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const EVE_NAMED_AGENT_ROUTE_PREFIX = "/eve/agents";
function resolveEveAgentHost(input) {
  if (input.agent === void 0) return input.host ?? "";
  if (input.host !== void 0)
    throw new Error(
      "useEveAgent cannot combine agent and host. Use one target option.",
    );
  assertValidAgentName(input.agent);
  return `${EVE_NAMED_AGENT_ROUTE_PREFIX}/${input.agent}`;
}
function assertValidAgentName(name) {
  if (!AGENT_NAME_PATTERN.test(name))
    throw new Error(
      `eve agent name ${JSON.stringify(name)} is invalid. Use lowercase letters, numbers, underscores, or hyphens, starting with a letter or number.`,
    );
}

//#endregion
//#region src/client/authorization-message-parts.ts
function createAuthorizationRequiredPart(event) {
  const displayName =
    event.data.authorization?.displayName ??
    formatAuthorizationDisplayName(event.data.name);
  return {
    authorization: event.data.authorization,
    description: normalizeAuthorizationDescription(
      event.data.description,
      event.data.name,
      displayName,
    ),
    displayName,
    name: event.data.name,
    state: "required",
    stepIndex: event.data.stepIndex,
    turnId: event.data.turnId,
    type: "authorization",
  };
}
function createAuthorizationCompletedPart(event, existing) {
  const displayName =
    event.data.authorization?.displayName ??
    existing?.displayName ??
    formatAuthorizationDisplayName(event.data.name);
  return {
    authorization:
      existing?.authorization || event.data.authorization
        ? {
            ...existing?.authorization,
            ...event.data.authorization,
          }
        : void 0,
    description:
      existing?.description ??
      buildCompletedAuthorizationDescription(
        displayName,
        event.data.outcome,
        event.data.reason,
      ),
    displayName,
    name: event.data.name,
    outcome: event.data.outcome,
    reason: event.data.reason,
    state: "completed",
    stepIndex: existing?.stepIndex ?? event.data.stepIndex,
    turnId: existing?.turnId ?? event.data.turnId,
    type: "authorization",
  };
}
function buildCompletedAuthorizationDescription(displayName, outcome, reason) {
  if (outcome === "authorized") return `${displayName} connected.`;
  return `${displayName} authorization ${outcome}${reason !== void 0 ? ` (${reason})` : ""}.`;
}
function normalizeAuthorizationDescription(description, name, displayName) {
  if (description === `Authorization required for ${name}`)
    return `Authorization required for ${displayName}`;
  return description;
}
function formatAuthorizationDisplayName(name) {
  if (name.length === 0) return name;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

//#endregion
//#region src/client/message-action-parts.ts
function toMessageInputRequest(request) {
  return {
    allowFreeform: request.allowFreeform,
    display: request.display,
    kind: request.kind,
    options: request.options,
    prompt: request.prompt,
    requestId: request.requestId,
  };
}
function createToolMetadata(descriptor, extra) {
  return {
    eve: {
      inputRequest: extra?.inputRequest,
      kind: descriptor.kind,
      name: descriptor.name,
    },
  };
}
function mergeToolMetadata(current, next) {
  const kind = next.eve?.kind ?? current?.eve?.kind ?? "unknown";
  const name = next.eve?.name ?? current?.eve?.name ?? "unknown";
  return {
    eve: {
      ...current?.eve,
      ...next.eve,
      inputRequest: next.eve?.inputRequest ?? current?.eve?.inputRequest,
      inputResponse: next.eve?.inputResponse ?? current?.eve?.inputResponse,
      kind,
      name,
    },
  };
}
function approvedApproval(part) {
  if (!part?.approval?.id) return;
  return {
    approved: true,
    id: part.approval.id,
    isAutomatic: part.approval.isAutomatic,
    reason: part.approval.reason,
  };
}
function normalizeActionRequest(action) {
  switch (action.kind) {
    case "load-skill":
      return {
        kind: "load-skill",
        name: "load_skill",
        toolName: "eve:load-skill",
      };
    case "tool-call":
      return {
        kind: "tool-call",
        name: action.toolName,
        toolName: action.toolName,
      };
    case "subagent-call":
      return {
        kind: "subagent-call",
        name: action.subagentName,
        toolName: `eve:subagent:${action.subagentName}`,
      };
    case "remote-agent-call":
      return {
        kind: "subagent-call",
        name: action.remoteAgentName,
        toolName: `eve:subagent:${action.remoteAgentName}`,
      };
  }
}
function normalizeActionResult(result) {
  switch (result.kind) {
    case "load-skill-result":
      return {
        kind: "load-skill",
        name: result.name ?? "load_skill",
        toolName: "eve:load-skill",
      };
    case "tool-result":
      return {
        kind: "tool-call",
        name: result.toolName,
        toolName: result.toolName,
      };
    case "subagent-result":
      return {
        kind: "subagent-call",
        name: result.subagentName,
        toolName: `eve:subagent:${result.subagentName}`,
      };
  }
}
function stringifyUnknown(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Action failed.";
  }
}

//#endregion
//#region src/client/message-reducer.ts
function defaultMessageReducer() {
  return {
    initial() {
      return { messages: [] };
    },
    reduce(data, event) {
      return reduceMessageData(data, event);
    },
  };
}
function reduceMessageData(data, event) {
  switch (event.type) {
    case "client.message.submitted":
      return upsertMessage(data, {
        id: optimisticUserMessageId(event.data.submissionId),
        metadata: {
          optimistic: true,
          status: "submitted",
        },
        parts: [
          {
            type: "text",
            text: event.data.message,
          },
        ],
        role: "user",
      });
    case "client.message.failed":
      return upsertMessage(data, {
        id: optimisticUserMessageId(event.data.submissionId),
        metadata: {
          optimistic: true,
          status: "failed",
        },
        parts: [
          {
            type: "text",
            text: event.data.message,
          },
        ],
        role: "user",
      });
    case "client.input.responded": {
      let next = data;
      for (const response of event.data.responses)
        next = respondToInputRequest(next, response);
      return next;
    }
    case "input.resolved": {
      let next = data;
      for (const resolution of event.data.resolutions)
        next = resolveInputRequest(next, resolution);
      return next;
    }
    case "message.received":
      return upsertMessage(data, {
        id: `${event.data.turnId}:user`,
        metadata: {
          status: "complete",
          turnId: event.data.turnId,
        },
        parts: projectReceivedParts(event.data.parts, event.data.message),
        role: "user",
      });
    case "step.started":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        ensureStepStartPart(message, event.data.stepIndex),
      );
    case "reasoning.appended":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertRun(ensureStepStartPart(message, event.data.stepIndex), {
          state: "streaming",
          stepIndex: event.data.stepIndex,
          text: event.data.reasoningSoFar,
          type: "reasoning",
        }),
      );
    case "reasoning.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertRun(ensureStepStartPart(message, event.data.stepIndex), {
          state: "done",
          stepIndex: event.data.stepIndex,
          text: event.data.reasoning,
          type: "reasoning",
        }),
      );
    case "actions.requested": {
      let next = data;
      for (const action of event.data.actions) {
        const descriptor = normalizeActionRequest(action);
        next = updateAssistantMessage(next, event.data.turnId, (message) =>
          upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
            input: "input" in action ? action.input : void 0,
            state: "input-available",
            stepIndex: event.data.stepIndex,
            toolCallId: action.callId,
            toolMetadata: createToolMetadata(descriptor),
            toolName: descriptor.toolName,
            type: "dynamic-tool",
          }),
        );
      }
      return next;
    }
    case "input.requested": {
      let next = data;
      for (const request of event.data.requests) {
        const descriptor = normalizeActionRequest(request.action);
        next = updateAssistantMessage(next, event.data.turnId, (message) =>
          upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
            approval: { id: request.requestId },
            input: request.action.input,
            state: "approval-requested",
            stepIndex: event.data.stepIndex,
            toolCallId: request.action.callId,
            toolMetadata: createToolMetadata(descriptor, {
              inputRequest: toMessageInputRequest(request),
            }),
            toolName: descriptor.toolName,
            type: "dynamic-tool",
          }),
        );
      }
      return next;
    }
    case "approval.candidate":
      return data;
    case "approval.settled": {
      const existing = findToolPartByApprovalId(data, event.data.requestId);
      if (existing === void 0) return data;
      if (event.data.outcome === "approved")
        return updateToolPart(data, existing.toolCallId, {
          approval: {
            approved: true,
            id: event.data.requestId,
            reason: void 0,
          },
          input: existing.input,
          state: "approval-responded",
          stepIndex: existing.stepIndex,
          toolCallId: existing.toolCallId,
          toolMetadata: existing.toolMetadata,
          toolName: existing.toolName,
          type: "dynamic-tool",
        });
      return updateToolPart(data, existing.toolCallId, {
        approval: {
          approved: false,
          id: event.data.requestId,
          reason: "Tool execution was cancelled.",
        },
        input: existing.input,
        state: "output-denied",
        stepIndex: existing.stepIndex,
        toolCallId: existing.toolCallId,
        toolMetadata: existing.toolMetadata,
        toolName: existing.toolName,
        type: "dynamic-tool",
      });
    }
    case "action.result": {
      const descriptor = normalizeActionResult(event.data.result);
      const existing = findToolPart(data, event.data.result.callId);
      const denied = event.data.error?.code === "TOOL_EXECUTION_DENIED";
      const failed = event.data.status === "failed" && !denied;
      const approvalId = existing?.approval?.id ?? event.data.result.callId;
      const toolMetadata = mergeToolMetadata(
        existing?.toolMetadata,
        createToolMetadata(descriptor),
      );
      const resultPartBase = {
        input: existing?.input,
        stepIndex: event.data.stepIndex,
        toolCallId: event.data.result.callId,
        toolMetadata,
        toolName: existing?.toolName ?? descriptor.toolName,
        type: "dynamic-tool",
      };
      let nextPart;
      if (denied)
        nextPart = {
          ...resultPartBase,
          approval: {
            approved: false,
            id: approvalId,
            reason: event.data.error?.message,
          },
          state: "output-denied",
        };
      else if (failed)
        nextPart = {
          ...resultPartBase,
          approval: approvedApproval(existing),
          errorText:
            event.data.error?.message ??
            stringifyUnknown(event.data.result.output),
          state: "output-error",
        };
      else
        nextPart = {
          ...resultPartBase,
          approval: approvedApproval(existing),
          output: event.data.result.output,
          state: "output-available",
        };
      if (existing !== void 0)
        return updateToolPart(data, event.data.result.callId, nextPart);
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertPart(
          ensureStepStartPart(message, event.data.stepIndex),
          nextPart,
        ),
      );
    }
    case "action.partial": {
      const existing = findToolPart(data, event.data.result.callId);
      if (existing !== void 0 && isSettledToolPart(existing)) return data;
      const descriptor = normalizeActionResult(event.data.result);
      const nextPart = {
        approval: approvedApproval(existing),
        input: existing?.input,
        output: event.data.result.output,
        partial: true,
        state: "output-available",
        stepIndex: event.data.stepIndex,
        toolCallId: event.data.result.callId,
        toolMetadata: mergeToolMetadata(
          existing?.toolMetadata,
          createToolMetadata(descriptor),
        ),
        toolName: existing?.toolName ?? descriptor.toolName,
        type: "dynamic-tool",
      };
      if (existing !== void 0)
        return updateToolPart(data, event.data.result.callId, nextPart);
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertPart(
          ensureStepStartPart(message, event.data.stepIndex),
          nextPart,
        ),
      );
    }
    case "authorization.required":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertPart(
          ensureStepStartPart(message, event.data.stepIndex),
          createAuthorizationRequiredPart(event),
        ),
      );
    case "authorization.completed":
      return completeAuthorization(data, event);
    case "message.appended":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertRun(ensureStepStartPart(message, event.data.stepIndex), {
          state: "streaming",
          stepIndex: event.data.stepIndex,
          text: event.data.messageSoFar,
          type: "text",
        }),
      );
    case "message.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) => {
        if (event.data.message === null)
          return removeTextPart(message, event.data.stepIndex);
        return upsertRun(ensureStepStartPart(message, event.data.stepIndex), {
          state: "done",
          stepIndex: event.data.stepIndex,
          text: event.data.message,
          type: "text",
        });
      });
    case "result.completed":
      return updateAssistantMetadata(data, event.data.turnId, {
        result: event.data.result,
      });
    case "turn.completed":
      return updateAssistantMetadata(data, event.data.turnId, {
        status: "complete",
      });
    case "turn.cancelled":
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: {
          ...message.metadata,
          status: "complete",
        },
        parts: message.parts.map((part) =>
          (part.type === "text" || part.type === "reasoning") &&
          part.state === "streaming"
            ? {
                ...part,
                state: "done",
              }
            : part,
        ),
      }));
    case "turn.failed":
    case "session.failed":
      return data;
    default:
      return data;
  }
}
function respondToInputRequest(data, response) {
  const existing = findToolPartByApprovalId(data, response.requestId);
  if (!existing) return data;
  const approval = { id: response.requestId };
  if (response.text !== void 0) approval.reason = response.text;
  return updateToolPart(data, existing.toolCallId, {
    approval,
    input: existing.input,
    state: "approval-responded",
    stepIndex: existing.stepIndex,
    toolCallId: existing.toolCallId,
    toolMetadata: mergeToolMetadata(existing.toolMetadata, {
      eve: {
        inputResponse: response,
        kind: existing.toolMetadata?.eve?.kind ?? "unknown",
        name: existing.toolMetadata?.eve?.name ?? existing.toolName,
      },
    }),
    toolName: existing.toolName,
    type: "dynamic-tool",
  });
}
function resolveInputRequest(data, resolution) {
  if (resolution.response !== void 0)
    return respondToInputRequest(data, resolution.response);
  const existing = findToolPartByApprovalId(data, resolution.requestId);
  if (!existing) return data;
  return updateToolPart(data, existing.toolCallId, {
    input: existing.input,
    output: { status: resolution.outcome },
    state: "output-available",
    stepIndex: existing.stepIndex,
    toolCallId: existing.toolCallId,
    toolMetadata: existing.toolMetadata,
    toolName: existing.toolName,
    type: "dynamic-tool",
  });
}
function updateAssistantMessage(data, turnId, update) {
  return upsertMessage(
    data,
    update(
      data.messages.find(
        (message) =>
          message.role === "assistant" && message.metadata?.turnId === turnId,
      ) ?? createAssistantMessage(turnId),
    ),
  );
}
function updateAssistantMetadata(data, turnId, metadata) {
  return updateAssistantMessage(data, turnId, (message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      ...metadata,
    },
  }));
}
function createAssistantMessage(turnId) {
  return {
    id: `${turnId}:assistant`,
    metadata: {
      status: "streaming",
      turnId,
    },
    parts: [],
    role: "assistant",
  };
}
function ensureStepStartPart(message, stepIndex) {
  const stepStartCount = message.parts.filter(
    (part) => part.type === "step-start",
  ).length;
  if (stepStartCount > stepIndex) return message;
  const missingCount = stepIndex - stepStartCount + 1;
  return {
    ...message,
    parts: [
      ...message.parts,
      ...Array.from({ length: missingCount }, () => ({ type: "step-start" })),
    ],
  };
}
function upsertPart(message, next) {
  const index = message.parts.findIndex(
    (part) => partKey(part) === partKey(next),
  );
  const parts =
    index === -1
      ? [...message.parts, next]
      : [
          ...message.parts.slice(0, index),
          next,
          ...message.parts.slice(index + 1),
        ];
  return {
    ...message,
    metadata: {
      ...message.metadata,
      status:
        next.type === "text" && next.state === "done"
          ? "complete"
          : "streaming",
    },
    parts,
  };
}
function upsertRun(message, next) {
  let lastIndex = -1;
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type === next.type && part.stepIndex === next.stepIndex) {
      lastIndex = index;
      break;
    }
  }
  const parts =
    lastIndex !== -1 && message.parts[lastIndex].state === "streaming"
      ? [
          ...message.parts.slice(0, lastIndex),
          next,
          ...message.parts.slice(lastIndex + 1),
        ]
      : [...message.parts, next];
  return {
    ...message,
    metadata: {
      ...message.metadata,
      status:
        next.type === "text" && next.state === "done"
          ? "complete"
          : "streaming",
    },
    parts,
  };
}
function removeTextPart(message, stepIndex) {
  const parts = message.parts.filter(
    (part) => part.type !== "text" || part.stepIndex !== stepIndex,
  );
  if (parts.length === message.parts.length) return message;
  return {
    ...message,
    metadata: {
      ...message.metadata,
      status: "complete",
    },
    parts,
  };
}
function updateToolPart(data, toolCallId, next) {
  const message = data.messages.find(
    (candidate) =>
      candidate.role === "assistant" &&
      candidate.parts.some(
        (part) =>
          part.type === "dynamic-tool" && part.toolCallId === toolCallId,
      ),
  );
  if (!message) return data;
  return upsertMessage(data, upsertPart(message, next));
}
function completeAuthorization(data, event) {
  const existing = findLatestPendingAuthorizationPart(data, event.data.name);
  const next = createAuthorizationCompletedPart(event, existing);
  if (existing !== void 0) return updateAuthorizationPart(data, existing, next);
  return updateAssistantMessage(data, event.data.turnId, (message) =>
    upsertPart(ensureStepStartPart(message, event.data.stepIndex), next),
  );
}
function updateAuthorizationPart(data, existing, next) {
  const message = data.messages.find(
    (candidate) =>
      candidate.role === "assistant" &&
      candidate.parts.some((part) => part === existing),
  );
  if (!message) return data;
  return upsertMessage(data, upsertPart(message, next));
}
function findToolPart(data, toolCallId) {
  for (const message of data.messages)
    for (const part of message.parts)
      if (part.type === "dynamic-tool" && part.toolCallId === toolCallId)
        return part;
}
function isSettledToolPart(part) {
  return (
    part.state === "output-denied" ||
    part.state === "output-error" ||
    (part.state === "output-available" && part.partial !== true)
  );
}
function findLatestPendingAuthorizationPart(data, name) {
  for (
    let messageIndex = data.messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = data.messages[messageIndex];
    if (message?.role !== "assistant") continue;
    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.parts[partIndex];
      if (
        part?.type === "authorization" &&
        part.state === "required" &&
        part.name === name
      )
        return part;
    }
  }
}
function findToolPartByApprovalId(data, approvalId) {
  for (const message of data.messages)
    for (const part of message.parts)
      if (part.type === "dynamic-tool" && part.approval?.id === approvalId)
        return part;
}
function projectReceivedParts(parts, message) {
  return (
    parts?.map((part) =>
      part.type === "text"
        ? {
            state: "done",
            text: part.text,
            type: "text",
          }
        : {
            filename: part.filename,
            mediaType: part.mediaType,
            size: part.size,
            type: "file",
            url: part.url,
          },
    ) ?? [
      {
        state: "done",
        text: message,
        type: "text",
      },
    ]
  );
}
function partKey(part) {
  switch (part.type) {
    case "text":
      return `text:${part.stepIndex ?? 0}`;
    case "reasoning":
      return `reasoning:${part.stepIndex ?? 0}`;
    case "file":
      return `file:${part.stepIndex ?? 0}:${part.filename ?? part.url ?? part.mediaType}`;
    case "step-start":
      return "step-start";
    case "authorization":
      return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
    case "dynamic-tool":
      return `dynamic-tool:${part.toolCallId}`;
  }
}
function upsertMessage(data, next) {
  const index = data.messages.findIndex((message) => message.id === next.id);
  if (index === -1) return { messages: [...data.messages, next] };
  return {
    messages: [
      ...data.messages.slice(0, index),
      next,
      ...data.messages.slice(index + 1),
    ],
  };
}
function optimisticUserMessageId(submissionId) {
  return `optimistic:${submissionId}:user`;
}

//#endregion
//#region src/vue/use-eve-agent.ts
function useEveAgent(options = {}) {
  const reducer = options.reducer ?? defaultMessageReducer();
  const store = new EveAgentStore({
    auth: options.auth,
    headers: options.headers,
    host: resolveEveAgentHost({
      agent: options.agent,
      host: options.host,
    }),
    initialEvents: options.initialEvents,
    initialSession: options.initialSession,
    optimistic: options.optimistic,
    reducer,
    session: options.session,
  });
  store.setCallbacks({
    onError: options.onError,
    onEvent: options.onEvent,
    onFinish: options.onFinish,
    onSessionChange: options.onSessionChange,
    prepareSend: options.prepareSend,
  });
  const snapshot = shallowRef(store.snapshot);
  if ("window" in globalThis) {
    const unsubscribe = store.subscribe(() => {
      snapshot.value = store.snapshot;
    });
    onScopeDispose(() => {
      unsubscribe();
      detachEveAgentStore(store);
    });
  }
  return {
    cancel: () => store.cancel(),
    data: computed(() => snapshot.value.data),
    error: computed(() => snapshot.value.error),
    events: computed(() => snapshot.value.events),
    reset: () => store.reset(),
    respond: (inputResponses, options) =>
      store.send({
        ...options,
        inputResponses,
      }),
    send: (message, options) =>
      store.send({
        ...options,
        message,
      }),
    session: computed(() => snapshot.value.session),
    status: computed(() => snapshot.value.status),
  };
}

//#endregion
export { defaultMessageReducer as n, useEveAgent as t };
