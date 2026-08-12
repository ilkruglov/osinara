/**
 * Reproducible local Eve 0.32.0 patch installer.
 *
 * Constructs:
 * - `replaceExact`: fail-fast, count-checked, idempotent artifact replacement.
 * - Production startup health wait: permits bounded first-run sandbox preparation.
 * - Model exact-once policy: disables Eve reissues and multi-call compaction recovery.
 * - Adapter approval policy: propagates failed `input.requested` persistence.
 * - Telegram durable ingress: verified-update and authenticated internal-drain hooks.
 * - Telegram dispatch extensions: Session return, message/token override, reply routing, and HITL auth.
 * - Telegram topic normalization: accepts thread IDs only on explicit forum-topic updates.
 * - Telegram public types: exposes only the reviewed application seams.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_EVE_VERSION = "0.32.0";
const EVE_PRODUCTION_START_HEALTH_TIMEOUT_MS = 300_000;

const runtimePaths = {
  channelAdapter: resolve("node_modules/eve/dist/src/channel/adapter.js"),
  channelAdapterTypes: resolve("node_modules/eve/dist/src/channel/adapter.d.ts"),
  compaction: resolve("node_modules/eve/dist/src/harness/compaction.js"),
  productionStart: resolve(
    "node_modules/eve/dist/src/internal/nitro/host/start-production-server.js",
  ),
  telegram: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.js",
  ),
  telegramInbound: resolve("node_modules/eve/dist/src/public/channels/telegram/inbound.js"),
  telegramIndexTypes: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/index.d.ts",
  ),
  telegramTypes: resolve(
    "node_modules/eve/dist/src/public/channels/telegram/telegramChannel.d.ts",
  ),
  toolLoop: resolve("node_modules/eve/dist/src/harness/tool-loop.js"),
} as const;

function occurrenceCount(source: string, marker: string): number {
  if (marker.length === 0) {
    throw new Error("AGENT_EVE_PATCH_MARKER_EMPTY: Eve patch marker cannot be empty");
  }
  return source.split(marker).length - 1;
}

async function replaceExact(
  path: string,
  before: string,
  after: string,
  expectedCount = 1,
): Promise<void> {
  const source = await readFile(path, "utf8");
  const beforeCount = occurrenceCount(source, before);
  const afterCount = occurrenceCount(source, after);
  const embeddedBeforeCount = occurrenceCount(after, before);
  const unpatchedBeforeCount = beforeCount - afterCount * embeddedBeforeCount;

  // A fully patched artifact is accepted unchanged; every partial or unknown state fails closed.
  if (unpatchedBeforeCount === 0 && afterCount === expectedCount) return;
  if (unpatchedBeforeCount !== expectedCount || afterCount !== 0) {
    throw new Error(
      `AGENT_EVE_PATCH_MISMATCH: Не удалось применить проверенный Eve 0.32.0 patch к ${path}; before=${beforeCount}, after=${afterCount}, expected=${expectedCount}`,
    );
  }

  await writeFile(path, source.split(before).join(after), "utf8");
}

// The package version gates every minified replacement against the exact reviewed release.
const evePackage = JSON.parse(
  await readFile(resolve("node_modules/eve/package.json"), "utf8"),
) as { version?: string };
if (evePackage.version !== EXPECTED_EVE_VERSION) {
  throw new Error(
    `AGENT_EVE_PATCH_VERSION_UNSUPPORTED: Ожидалась Eve ${EXPECTED_EVE_VERSION}, установлена ${String(evePackage.version)}`,
  );
}

// A cold production start may prepare sandbox images before the child server becomes healthy.
await replaceExact(
  runtimePaths.productionStart,
  "const HEALTH_TIMEOUT_MS=6e4",
  `const HEALTH_TIMEOUT_MS=${EVE_PRODUCTION_START_HEALTH_TIMEOUT_MS.toExponential().replace("+", "")}`,
);

// Provider transport retries remain AI SDK's responsibility; Eve must never reissue a model call.
await replaceExact(
  runtimePaths.toolLoop,
  "async function runModelCallWithRetries(e,t,n){for(let r=1;;r++){throwIfTurnAborted(n);try{return await e(r)}catch(e){if(throwIfTurnAborted(n),r===3||classifyModelCallError(e)!==`retry`)throw e;let i=500*2**(r-1)+Math.floor(Math.random()*250);log.warn(`model call failed transiently — retrying`,{attempt:r,delayMs:i,sessionId:t.sessionId,turnId:t.turnId,error:e}),await new Promise(e=>setTimeout(e,i))}}}",
  "async function runModelCallWithRetries(e,t,n){throwIfTurnAborted(n);try{return await e(1)}catch(e){throwIfTurnAborted(n);throw e}}",
);
await replaceExact(
  runtimePaths.toolLoop,
  "async function attemptEmptyResponseRecovery(e){if(!(e.error instanceof EmptyModelResponseError))return{outcome:`skipped`};log.warn(`empty model response; reissuing the model call once`,{sessionId:e.sessionId,turnId:e.turnId});try{return{outcome:`recovered`,result:await e.runOneModelCall({...e.retryCallOptions,retryReason:`empty-response`,suppressStepStartedEmission:!0,trailingUserNote:buildEmptyResponseNudge(e.emptyDeliveryEnabled)})}}catch(t){return{outcome:`failed`,error:t,retryCallOptions:e.retryCallOptions}}}",
  "async function attemptEmptyResponseRecovery(e){return{outcome:`skipped`}}",
);
await replaceExact(
  runtimePaths.toolLoop,
  "async function attemptUnsupportedProviderToolRecovery(e){let t=extractUnsupportedProviderToolTypes(e.error);if(t.length===0)return{outcome:`skipped`};let n=[];for(let e of t){let t=resolveFrameworkToolFromUpstreamType(e);t!==null&&!n.includes(t)&&n.push(t)}if(n.length===0)return{outcome:`skipped`};log.warn(`disabling unsupported provider tool(s); retrying step once`,{disabled:n,sessionId:e.sessionId,turnId:e.turnId,upstreamTypes:t});let r={disabledProviderTools:new Set(n),extraSystemNote:buildDisabledToolNote(n)};try{return{outcome:`recovered`,result:await e.runOneModelCall({...r,suppressStepStartedEmission:!0})}}catch(e){return{outcome:`failed`,error:e,retryCallOptions:r}}}",
  "async function attemptUnsupportedProviderToolRecovery(e){return{outcome:`skipped`}}",
);

// Compaction may shrink the local recent window, but it may not buy another summary model call.
await replaceExact(
  runtimePaths.compaction,
  "if(evaluateThreshold(v,i,`estimate`).type===`within-limit`||m===0)return v;--m",
  "if(evaluateThreshold(v,i,`estimate`).type===`within-limit`)return v;throw Error(`EVE_COMPACTION_OUTPUT_TOO_LARGE: Compaction result exceeds the configured threshold`)",
);

// Failure to persist an approval prompt must fail the turn instead of parking it unbound.
await replaceExact(
  runtimePaths.channelAdapter,
  "catch(r){log.error(`adapter event handler threw — event swallowed`,{adapterKind:getAdapterKind(e),eventType:n.type,error:r})}return withWaitingContinuationToken(i,r)",
  "catch(r){log.error(`adapter event handler threw`,{adapterKind:getAdapterKind(e),eventType:n.type,error:r});if(n.type===`input.requested`)throw r}return withWaitingContinuationToken(i,r)",
);
await replaceExact(
  runtimePaths.channelAdapterTypes,
  " * Throwing handlers are logged and swallowed so a downstream delivery\n * failure does not corrupt the event stream write path.",
  " * Throwing handlers are logged and swallowed except for `input.requested`, whose\n * failure propagates so an unbound human approval cannot remain parked fail-open.",
);

// Verified webhooks can be durably acknowledged before native dispatch; drain reuses that dispatcher.
await replaceExact(
  runtimePaths.telegram,
  "let u=parseTelegramUpdate(c);return u===null?new Response(`ok`):u.kind===`message`?(o(dispatchMessage({config:e,message:u.message,onMessage:n,uploadPolicy:t,from:a})),new Response(`ok`)):(o(dispatchCallbackQuery({config:e,query:u.callbackQuery,from:a})),new Response(`ok`))",
  "let u=parseTelegramUpdate(c);if(u===null)return new Response(`ok`);let d=l=>l.kind===`message`?dispatchMessage({config:e,message:l.message,onMessage:n,uploadPolicy:t,from:a}):dispatchCallbackQuery({config:e,query:l.callbackQuery,from:a});return e.onVerifiedUpdate!==void 0?e.onVerifiedUpdate({dispatch:d,raw:c,update:u,waitUntil:o}):(o(d(u)),new Response(`ok`))",
);
await replaceExact(
  runtimePaths.telegram,
  "})],async receive",
  "}),...e.onDrain===void 0?[]:[POST(e.drainRoute??`/eve/v1/telegram-drain`,async(r,{from:a,waitUntil:o})=>{if(await verifyInbound(r,e.credentials)===null)return new Response(`unauthorized`,{status:401});let d=l=>l.kind===`message`?dispatchMessage({config:e,message:l.message,onMessage:n,uploadPolicy:t,from:a}):dispatchCallbackQuery({config:e,query:l.callbackQuery,from:a});return e.onDrain({dispatch:d,waitUntil:o})})]],async receive",
);

// Authorized application output controls only the model-visible message and continuation address.
await replaceExact(
  runtimePaths.telegram,
  "catch(e){log.error(`message handler failed`,{error:e});return}if(r==null)return",
  "catch(e){log.error(`message handler failed`,{error:e});throw e}if(r==null)return",
);
await replaceExact(
  runtimePaths.telegram,
  "u=e.message.replyToMessage?.from?.isBot===!0&&l.trim().length>0?",
  "u=r.replyHandling!==`message`&&e.message.replyToMessage?.from?.isBot===!0&&l.trim().length>0?",
);
await replaceExact(
  runtimePaths.telegram,
  "let n=e.from(continuationTokenFromState(t));u===void 0?await n.send(a,{auth:r.auth,context:[o,...s],state:t}):await n.respond(u,{auth:r.auth,context:[o,...s]})",
  "let n=e.from(r.continuationToken??continuationTokenFromState(t));return u===void 0?await n.send(r.message??a,{auth:r.auth,context:[o,...s],state:t}):await n.respond(u,{auth:r.auth,context:[o,...s]})",
);
await replaceExact(
  runtimePaths.telegram,
  "catch(e){log.error(`message delivery failed`,{error:e})}}async function dispatchCallbackQuery",
  "catch(e){log.error(`message delivery failed`,{error:e});throw e}}async function dispatchCallbackQuery",
);

// HITL callbacks are acknowledged only after application authentication selects auth and routing.
await replaceExact(
  runtimePaths.telegram,
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}if(!e.query.message||!t.chatId)return;try{await e.from(continuationTokenFromState(t)).respond([telegramCallbackInputResponse(e.query.data)],{auth:null})}catch(e){log.error(`callback query delivery failed`,{error:e})}return}",
  "if(e.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX)===!0){if(!e.query.message||!t.chatId)return;let r=continuationTokenFromState(t),i=e.config.onHitlCallbackQuery===void 0?{auth:null,continuationToken:e.config.resolveContinuationToken===void 0?r:await e.config.resolveContinuationToken(r)}:await e.config.onHitlCallbackQuery(n,e.query,r);if(i===null)return;try{await n.telegram.answerCallbackQuery({callbackQueryId:e.query.id,text:i.acknowledgementText??`Answer received.`})}catch(e){log.warn(`Telegram callback-query acknowledgement failed`,{error:e})}try{return await e.from(i.continuationToken??r).respond([telegramCallbackInputResponse(e.query.data)],{auth:i.auth})}catch(e){log.error(`callback query delivery failed`,{error:e});throw e}}",
);

// Telegram emits pseudo thread IDs on ordinary replies; only explicit topic messages define scope.
await replaceExact(
  runtimePaths.telegramInbound,
  "messageThreadId:typeof e.message_thread_id==`number`?e.message_thread_id:void 0",
  "messageThreadId:e.is_topic_message===!0&&typeof e.message_thread_id==`number`?e.message_thread_id:void 0",
  2,
);

// Public declarations match runtime hooks without exposing an unverified Request to the application.
await replaceExact(
  runtimePaths.telegramTypes,
  'import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage } from "#public/channels/telegram/inbound.js";',
  'import { type TelegramCallbackQuery, type TelegramChatType, type TelegramMessage, type TelegramUpdate } from "#public/channels/telegram/inbound.js";\nimport type { Session } from "#channel/session.js";',
);
const telegramHookDeclarations = `/** Verified Telegram ingress hook context for durable application queues. */
export interface TelegramVerifiedUpdateContext {
    readonly raw: JsonObject;
    readonly update: TelegramUpdate;
    readonly dispatch: (update: TelegramUpdate) => Promise<Session | null | undefined>;
    readonly waitUntil: (task: Promise<unknown>) => void;
}
/** Internal drain hook context using the native verified Telegram dispatcher. */
export interface TelegramDrainContext {
    readonly dispatch: (update: TelegramUpdate) => Promise<Session | null | undefined>;
    readonly waitUntil: (task: Promise<unknown>) => void;
}
/** Application-authenticated result for a Telegram HITL callback. */
export type TelegramHitlCallbackResult = {
    readonly acknowledgementText?: string;
    readonly auth: SessionAuthContext | null;
    readonly continuationToken?: string;
} | null;
`;
await replaceExact(
  runtimePaths.telegramTypes,
  "/** Configuration for {@link telegramChannel}. */",
  `${telegramHookDeclarations}/** Configuration for {@link telegramChannel}. */`,
);
await replaceExact(
  runtimePaths.telegramTypes,
  "export type TelegramInboundResult = {\n    readonly auth: SessionAuthContext | null;\n    readonly context?: readonly string[];\n} | null;",
  "export type TelegramInboundResult = {\n    readonly auth: SessionAuthContext | null;\n    readonly context?: readonly string[];\n    readonly continuationToken?: string;\n    readonly message?: string;\n    readonly replyHandling?: \"message\";\n} | null;",
);
const telegramConfigHooks = `    /** Optional internal endpoint that resumes persisted ingress after process restarts. */
    readonly drainRoute?: string;
    /** Drains persisted updates through the native verified dispatcher. */
    readonly onDrain?: (context: TelegramDrainContext) => Response | Promise<Response>;
    /** Resolves a versioned token when no authenticated HITL callback hook is configured. */
    readonly resolveContinuationToken?: (baseToken: string) => string | Promise<string>;
    /** Authenticates the verified Telegram user before a HITL callback resumes Eve. */
    readonly onHitlCallbackQuery?: (ctx: TelegramContext, query: TelegramCallbackQuery, continuationToken: string) => TelegramHitlCallbackResult | Promise<TelegramHitlCallbackResult>;
    /** Runs after webhook verification and parsing, before native dispatch. */
    readonly onVerifiedUpdate?: (context: TelegramVerifiedUpdateContext) => Response | Promise<Response>;
`;
await replaceExact(
  runtimePaths.telegramTypes,
  "    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */",
  `${telegramConfigHooks}    /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */`,
);
await replaceExact(
  runtimePaths.telegramIndexTypes,
  "type TelegramInboundResultOrPromise, type TelegramReceiveTarget, }",
  "type TelegramDrainContext, type TelegramHitlCallbackResult, type TelegramInboundResultOrPromise, type TelegramReceiveTarget, type TelegramVerifiedUpdateContext, }",
);
