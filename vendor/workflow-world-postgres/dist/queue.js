import { timingSafeEqual } from "node:crypto";
import { connect } from "node:net";
import * as Stream from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createWorkflowBaseUrl,
  createWorkflowHealthEndpoint,
  createWorkflowUrl,
} from "@workflow/utils";
import { getWorkflowPort } from "@workflow/utils/get-port";
import {
  getQueueTopicPrefix,
  MessageId,
  parseQueueName,
  QueuePayloadSchema,
  resolveQueueNamespace,
  WorkflowInvokePayloadSchema,
} from "@workflow/world";
import { createWorld } from "@workflow/world-local";
import { Logger, makeWorkerUtils, run } from "graphile-worker";
import { monotonicFactory } from "ulid";
import { z } from "zod/v4";
import {
  Agent as OsinaraLoopbackAgent,
  fetch as osinaraLoopbackFetch,
} from "undici";
// Above Workflow's 900 s inline ownership ceiling, so a long step settles before the call gives up.
const OSINARA_LOOPBACK_TIMEOUT_MS = 20 * 60 * 1000;
const OSINARA_LOOPBACK_DISPATCHER = new OsinaraLoopbackAgent({
  headersTimeout: OSINARA_LOOPBACK_TIMEOUT_MS,
  bodyTimeout: OSINARA_LOOPBACK_TIMEOUT_MS,
});
import { MessageData } from "./message.js";
function createGraphileLogger() {
  const isJsonMode = () => process.env.WORKFLOW_JSON_MODE === "1";
  const isVerbose = () => Boolean(process.env.DEBUG);
  return new Logger(() => (level, message, meta) => {
    if (isJsonMode()) return;
    if ((level === "debug" || level === "info") && !isVerbose()) return;
    const pipe = level === "error" ? process.stderr : process.stdout;
    if (meta) {
      pipe.write(
        `[Graphile Worker] ${message} ${JSON.stringify(meta, null, 2)}\n`,
      );
    } else {
      pipe.write(`[Graphile Worker] ${message}\n`);
    }
  });
}
const graphileLogger = createGraphileLogger();
const COMPLETED_IDEMPOTENCY_CACHE_LIMIT = 10_000;
// Core records MAX_DELIVERIES_EXCEEDED on delivery 49.
const MAX_GRAPHILE_JOB_ATTEMPTS = 49;
const GraphileHelpers = z.object({
  abortSignal: z.instanceof(AbortSignal).optional(),
  job: z.object({
    attempts: z.number().int().positive(),
  }),
});
export function createQueue(config, pool) {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const localWorld = createWorld({ dataDir: undefined, port });
  // JSON transport that preserves Uint8Array values via a tagged
  // envelope ({ __type: 'Uint8Array', data: '<base64>' }).  Required
  // for the resilient start path where runInput.input (a Uint8Array)
  // is sent through the queue.
  const transport = {
    contentType: "application/json",
    serialize(value) {
      return Buffer.from(
        JSON.stringify(value, (_key, v) =>
          v instanceof Uint8Array
            ? { __type: "Uint8Array", data: Buffer.from(v).toString("base64") }
            : v,
        ),
      );
    },
    async deserialize(stream) {
      const chunks = [];
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString(), (_key, v) =>
        v !== null &&
        typeof v === "object" &&
        v.__type === "Uint8Array" &&
        typeof v.data === "string"
          ? new Uint8Array(Buffer.from(v.data, "base64"))
          : v,
      );
    },
  };
  const generateMessageId = monotonicFactory();
  function getJobQueueName() {
    const jobPrefix = config.jobPrefix || "workflow_";
    return `${jobPrefix}flows`;
  }
  // Osinara: the flow route is on the agent's own listener and reachable from the app network;
  // the official handler checks header shape but no secret (security audit, 6 October 2026,
  // N-2). The queue sends the agent's internal token and the handler refuses anything else before
  // the official one reads a byte. The same token guards the drain route and the approval sweep.
  const requireInternalToken = () => {
    const token = process.env.AGENT_INTERNAL_TOKEN;
    if (!token) throw new Error("AGENT_INTERNAL_TOKEN_MISSING: Не задан внутренний токен для маршрута очереди");
    return token;
  };
  const isInternalTokenAuthorized = (presented) => {
    if (typeof presented !== "string") return false;
    const expected = Buffer.from(requireInternalToken());
    const given = Buffer.from(presented);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };
  const createQueueHandler = (prefix, handle) => {
    const official = localWorld.createQueueHandler(prefix, handle);
    return async (request) => {
      if (!isInternalTokenAuthorized(request.headers.get("x-osinara-internal-token"))) {
        return new Response(null, { status: 401 });
      }
      return official(request);
    };
  };
  const getDeploymentId = async () => {
    return "postgres";
  };
  const completedMessages = new Set();
  const inflightMessages = new Map();
  const inflightWorkflowRuns = new Map();
  let workerUtils = null;
  let runner = null;
  let runnerStart = null;
  let closing = false;
  let startPromise = null;
  function markMessageCompleted(idempotencyKey) {
    completedMessages.delete(idempotencyKey);
    completedMessages.add(idempotencyKey);
    if (completedMessages.size > COMPLETED_IDEMPOTENCY_CACHE_LIMIT) {
      const oldestKey = completedMessages.values().next().value;
      if (oldestKey) {
        completedMessages.delete(oldestKey);
      }
    }
  }
  async function addGraphileJob({
    queueId,
    body,
    messageId,
    attempt,
    idempotencyKey,
    headers,
    delaySeconds,
    jobKey,
  }) {
    const utils = workerUtils;
    if (!utils) {
      throw new Error("Postgres queue worker utils are not initialized");
    }
    const runAt =
      typeof delaySeconds === "number" && delaySeconds > 0
        ? new Date(Date.now() + delaySeconds * 1000)
        : undefined;
    await utils.addJob(
      getJobQueueName(),
      MessageData.encode({
        id: queueId,
        data: Buffer.from(body),
        attempt,
        messageId,
        idempotencyKey,
        headers,
      }),
      {
        ...(jobKey ? { jobKey } : {}),
        ...(runAt ? { runAt } : {}),
        maxAttempts: MAX_GRAPHILE_JOB_ATTEMPTS,
      },
    );
  }
  async function getExecutionBaseUrl() {
    if (process.env.WORKFLOW_LOCAL_BASE_URL) {
      return process.env.WORKFLOW_LOCAL_BASE_URL;
    }
    if (typeof port === "number") {
      return createWorkflowBaseUrl(`http://localhost:${port}`);
    }
    if (process.env.PORT) {
      return createWorkflowBaseUrl(`http://localhost:${process.env.PORT}`);
    }
    const detectedPort = await getWorkflowPort({
      endpoint: createWorkflowHealthEndpoint(),
    });
    if (typeof detectedPort === "number") {
      return createWorkflowBaseUrl(`http://localhost:${detectedPort}`);
    }
    return undefined;
  }
  function getLoopbackHosts(hostname) {
    if (hostname === "localhost") {
      return ["127.0.0.1", "::1"];
    }
    if (hostname === "[::1]") {
      return ["::1"];
    }
    return hostname === "127.0.0.1" || hostname === "::1" ? [hostname] : [];
  }
  function getLoopbackTarget(baseUrl) {
    if (!baseUrl) {
      return undefined;
    }
    const url = new URL(baseUrl);
    const hosts = getLoopbackHosts(url.hostname);
    if (hosts.length === 0) {
      return undefined;
    }
    return {
      hosts,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    };
  }
  async function canConnectToLoopbackTarget(target) {
    for (const host of target.hosts) {
      const reachable = await new Promise((resolve) => {
        const socket = connect({ host, port: target.port });
        socket.unref();
        const finish = (isReachable) => {
          socket.destroy();
          resolve(isReachable);
        };
        socket.setTimeout(200, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
      });
      if (reachable) {
        return true;
      }
    }
    return false;
  }
  async function startRunnerUnlessAborted(controller) {
    if (controller.signal.aborted) {
      return;
    }
    await setupListeners();
  }
  async function waitForLoopbackAndStartRunner(controller, target) {
    while (
      !controller.signal.aborted &&
      !(await canConnectToLoopbackTarget(target))
    ) {
      await sleep(50, undefined, {
        ref: false,
      });
    }
    await startRunnerUnlessAborted(controller);
  }
  function deferRunnerStart(controller, target) {
    const promise = waitForLoopbackAndStartRunner(controller, target)
      .catch((err) => {
        if (!controller.signal.aborted) {
          console.warn(
            "[world-postgres] Failed to start Graphile Worker after local workflow executor became reachable:",
            err,
          );
        }
      })
      .finally(() => {
        if (runnerStart?.promise === promise) {
          runnerStart = null;
        }
      });
    runnerStart = { controller, promise };
  }
  async function executeMessageOverHttp({
    queueName,
    messageId,
    attempt,
    body,
    headers: extraHeaders,
    abortSignal,
  }) {
    const headers = {
      ...extraHeaders,
      "content-type": "application/json",
      "x-osinara-internal-token": requireInternalToken(),
      "x-vqs-queue-name": queueName,
      "x-vqs-message-id": messageId,
      "x-vqs-message-attempt": String(attempt),
    };
    const baseUrl = await getExecutionBaseUrl();
    if (!baseUrl) {
      throw new Error("Unable to resolve base URL for workflow queue.");
    }
    const response = await osinaraLoopbackFetch(
      createWorkflowUrl(baseUrl, { type: "flow" }),
      {
        method: "POST",
        duplex: "half",
        headers,
        body,
        signal: abortSignal,
        dispatcher: OSINARA_LOOPBACK_DISPATCHER,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      return {
        type: "error",
        status: response.status,
        text,
        headers: Object.fromEntries(response.headers.entries()),
      };
    }
    try {
      const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
      if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
        return { type: "reschedule", timeoutSeconds };
      }
    } catch {}
    return { type: "completed" };
  }
  async function migratePgBossJobs(utils) {
    // Scenario A: Drizzle migration already ran — staging table exists
    const hasStaging = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'workflow'
        AND table_name = '_pgboss_pending_jobs'
      ) AS exists`);
    if (hasStaging.rows[0]?.exists) {
      const jobs =
        await pool.query(`SELECT name, data, singleton_key, retry_limit
        FROM "workflow"."_pgboss_pending_jobs"`);
      for (const job of jobs.rows) {
        await utils.addJob(job.name, job.data, {
          jobKey: job.singleton_key ?? undefined,
          maxAttempts: Math.max(
            job.retry_limit ?? 0,
            MAX_GRAPHILE_JOB_ATTEMPTS,
          ),
        });
      }
      await pool.query(`DROP TABLE "workflow"."_pgboss_pending_jobs"`);
      return;
    }
    // Scenario B: Drizzle migration didn't run — pgboss schema still exists
    const hasPgBoss = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata
        WHERE schema_name = 'pgboss'
      ) AS exists`);
    if (hasPgBoss.rows[0]?.exists) {
      const jobs =
        await pool.query(`SELECT name, data, singleton_key, retry_limit
        FROM pgboss.job
        WHERE state IN ('created', 'retry')`);
      for (const job of jobs.rows) {
        await utils.addJob(job.name, job.data, {
          jobKey: job.singleton_key ?? undefined,
          maxAttempts: Math.max(
            job.retry_limit ?? 0,
            MAX_GRAPHILE_JOB_ATTEMPTS,
          ),
        });
      }
      await pool.query(`DROP SCHEMA pgboss CASCADE`);
    }
  }
  async function startRunnerWhenExecutorIsReady() {
    if (closing || runner || runnerStart) {
      return;
    }
    const controller = new AbortController();
    const promise = (async () => {
      const target = getLoopbackTarget(await getExecutionBaseUrl());
      if (!target) {
        await startRunnerUnlessAborted(controller);
        return;
      }
      if (await canConnectToLoopbackTarget(target)) {
        await startRunnerUnlessAborted(controller);
        return;
      }
      if (controller.signal.aborted) {
        return;
      }
      deferRunnerStart(controller, target);
    })().finally(() => {
      if (runnerStart?.promise === promise) {
        runnerStart = null;
      }
    });
    runnerStart = { controller, promise };
    await promise;
  }
  async function start() {
    if (closing) {
      return;
    }
    if (!startPromise) {
      startPromise = (async () => {
        try {
          workerUtils = await makeWorkerUtils({
            pgPool: pool,
            logger: graphileLogger,
          });
          await workerUtils.migrate();
          await migratePgBossJobs(workerUtils);
          await startRunnerWhenExecutorIsReady();
        } catch (err) {
          startPromise = null;
          throw err;
        }
      })();
    }
    await startPromise;
    if (!closing && !runner && !runnerStart) {
      await startRunnerWhenExecutorIsReady();
    }
  }
  const queue = async (queue, message, opts) => {
    await start();
    const { id: queueId } = parseQueueName(queue);
    const body = transport.serialize(message);
    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    await addGraphileJob({
      queueId,
      body,
      messageId,
      attempt: 1,
      idempotencyKey: opts?.idempotencyKey,
      headers: opts?.headers,
      delaySeconds: opts?.delaySeconds,
      jobKey: opts?.idempotencyKey ?? messageId,
    });
    return { messageId };
  };
  async function deserializeMessageBody(data) {
    const bodyStream = Stream.Readable.toWeb(Stream.Readable.from([data]));
    return transport.deserialize(bodyStream);
  }
  function createTaskHandler(queue) {
    return async (payload, helpers) => {
      const messageData = MessageData.parse(payload);
      const graphileHelpers = GraphileHelpers.safeParse(helpers);
      const attempt = graphileHelpers.success
        ? graphileHelpers.data.job.attempts
        : messageData.attempt;
      const queueName = `${queue}${messageData.id}`;
      const body = await deserializeMessageBody(messageData.data);
      QueuePayloadSchema.parse(body);
      const workflowInvoke = WorkflowInvokePayloadSchema.safeParse(body);
      const workflowRunSerializationKey =
        workflowInvoke.success && !workflowInvoke.data.stepId
          ? `workflow:${workflowInvoke.data.runId}`
          : undefined;
      const executeTask = async () => {
        const result = await executeMessageOverHttp({
          queueName,
          messageId: messageData.messageId,
          attempt,
          body: messageData.data,
          headers: messageData.headers,
          abortSignal: graphileHelpers.success
            ? graphileHelpers.data.abortSignal
            : undefined,
        });
        if (result.type === "completed") {
          return "completed";
        }
        if (result.type === "reschedule") {
          // Schedule the follow-up job before we return so a crash cannot
          // lose the wake-up request.
          await addGraphileJob({
            queueId: messageData.id,
            body: messageData.data,
            messageId: messageData.messageId,
            attempt: attempt + 1,
            idempotencyKey: messageData.idempotencyKey,
            headers: messageData.headers,
            delaySeconds: result.timeoutSeconds,
            jobKey: messageData.idempotencyKey ?? messageData.messageId,
          });
          return "rescheduled";
        }
        throw new Error(
          `[postgres world] Queue execution failed (${result.status}): ${result.text}`,
        );
      };
      const idempotencyKey = messageData.idempotencyKey;
      if (!idempotencyKey) {
        if (workflowRunSerializationKey) {
          // Preserve step fan-out while preventing two workflow replays from
          // mutating the same run's event log at the same time.
          const previous = inflightWorkflowRuns.get(
            workflowRunSerializationKey,
          );
          const execution = (previous ?? Promise.resolve())
            .catch(() => {})
            .then(() => executeTask())
            .finally(() => {
              if (
                inflightWorkflowRuns.get(workflowRunSerializationKey) ===
                execution
              ) {
                inflightWorkflowRuns.delete(workflowRunSerializationKey);
              }
            });
          inflightWorkflowRuns.set(workflowRunSerializationKey, execution);
          await execution;
          return;
        }
        await executeTask();
        return;
      }
      if (completedMessages.has(idempotencyKey)) {
        return;
      }
      const existing = inflightMessages.get(idempotencyKey);
      if (existing) {
        await existing;
        return;
      }
      const execution = executeTask()
        .then((result) => {
          if (result === "completed") {
            markMessageCompleted(idempotencyKey);
          }
        })
        .finally(() => {
          inflightMessages.delete(idempotencyKey);
        });
      inflightMessages.set(idempotencyKey, execution);
      await execution;
    };
  }
  async function setupListeners() {
    const taskList = {};
    const namespace = resolveQueueNamespace(config.namespace);
    const workflowPrefix = getQueueTopicPrefix("workflow", namespace);
    taskList[getJobQueueName()] = createTaskHandler(workflowPrefix);
    runner = await run({
      pgPool: pool,
      // Default of 50 is high enough to avoid worker-pool exhaustion in
      // workflows that use parent→child polling patterns (e.g. awaiting a
      // child workflow via `childRun.returnValue` inside the parent).
      // Every such poll holds a worker slot for the duration of the child
      // run. Recursive workflows like `fibonacciWorkflow` fan out quickly
      // — fib(6) produces ~24 concurrent polling steps at peak, and at
      // concurrency=10 (the previous default) it would deadlock on the
      // default Postgres setup. See packages/core/src/runtime/run.ts and
      // docs/content/docs/changelog/eager-processing.mdx for context.
      concurrency: config.queueConcurrency || 50,
      logger: graphileLogger,
      ...(config.applicationManagedShutdown === true && {
        noHandleSignals: true,
      }),
      // Osinara: jobs wake runners through LISTEN/NOTIFY; the poll is only a fallback, and at 0.5 s per
      // replica it added load to a saturated database in the 10 000-family run (3 October 2026).
      pollInterval: 2_000,
      taskList,
    });
  }
  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    start,
    async close() {
      closing = true;
      if (runnerStart) {
        runnerStart.controller.abort();
        await runnerStart.promise;
        runnerStart = null;
      }
      await startPromise?.catch(() => {});
      const activeRunner = runner;
      if (activeRunner) {
        try {
          await activeRunner.stop();
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Runner is already stopped"
          ) {
            throw error;
          }
        }
        await activeRunner.promise.catch(() => {});
        runner = null;
      }
      if (workerUtils) {
        await workerUtils.release();
        workerUtils = null;
      }
      startPromise = null;
      await localWorld.close?.();
    },
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicXVldWUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvcXVldWUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLFVBQVUsQ0FBQztBQUNuQyxPQUFPLEtBQUssTUFBTSxNQUFNLGFBQWEsQ0FBQztBQUN0QyxPQUFPLEVBQUUsVUFBVSxJQUFJLEtBQUssRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRTNELE9BQU8sRUFDTCxxQkFBcUIsRUFDckIsNEJBQTRCLEVBQzVCLGlCQUFpQixHQUNsQixNQUFNLGlCQUFpQixDQUFDO0FBQ3pCLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUMzRCxPQUFPLEVBQ0wsbUJBQW1CLEVBQ25CLFNBQVMsRUFDVCxjQUFjLEVBRWQsa0JBQWtCLEVBRWxCLHFCQUFxQixFQUVyQiwyQkFBMkIsR0FDNUIsTUFBTSxpQkFBaUIsQ0FBQztBQUN6QixPQUFPLEVBQUUsV0FBVyxFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDcEQsT0FBTyxFQUNMLE1BQU0sRUFDTixlQUFlLEVBRWYsR0FBRyxHQUVKLE1BQU0saUJBQWlCLENBQUM7QUFFekIsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sTUFBTSxDQUFDO0FBQ3hDLE9BQU8sRUFBRSxDQUFDLEVBQUUsTUFBTSxRQUFRLENBQUM7QUFFM0IsT0FBTyxFQUFFLFdBQVcsRUFBRSxNQUFNLGNBQWMsQ0FBQztBQUUzQyxTQUFTLG9CQUFvQjtJQUMzQixNQUFNLFVBQVUsR0FBRyxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQixLQUFLLEdBQUcsQ0FBQztJQUNoRSxNQUFNLFNBQVMsR0FBRyxHQUFHLEVBQUUsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUVuRCxPQUFPLElBQUksTUFBTSxDQUFDLEdBQUcsRUFBRSxDQUFDLENB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RyxJQUFJLENBQUM7WUFDckIsQ0FBQztZQUNELFlBQVksR0FBRyxJQUFJLENBQUM7WUFDcEIsTUFBTSxVQUFVLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQztRQUM3QixDQUFDO0tBQ0YsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBjb25uZWN0IH0gZnJvbSAnbm9kZTpuZXQnO1xuaW1wb3J0ICogYXMgU3RyZWFtIGZyb20gJ25vZGU6c3RyZWFtJztcbmltcG9ydCB7IHNldFRpbWVvdXQgYXMgc2xlZXAgfSBmcm9tICdub2RlOnRpbWVycy9wcm9taXNlcyc7XG5pbXBvcnQgdHlwZSB7IFRyYW5zcG9ydCB9IGZyb20gJ0B2ZXJjZWwvcXVldWUnO1xuaW1wb3J0IHtcbiAgY3JlYXRlV29ya2Zsb3dCYXNlVXJsLFxuICBjcmVhdGVXb3JrZmxvd0hlYWx0aEVuZHBvaW50LFxuICBjcmVhdGVXb3JrZmxvd1VybCxcbn0gZnJvbSAnQHdvcmtmbG93L3V0aWxzJztcbmltcG9ydCB7IGdldFdvcmtmbG93UG9ydCB9IGZyb20gJ0B3b3JrZmxvdy91dGlscy9nZXQtcG9ydCc7XG5pbXBvcnQge1xuICBnZXRRdWV1ZVRvcGljUHJlZml4LFxuICBNZXNzYWdlSWQsXG4gIHBhcnNlUXVldWVOYW1lLFxuICB0eXBlIFF1ZXVlLFxuICBRdWV1ZVBheWxvYWRTY2hlbWEsXG4gIHR5cGUgUXVldWVQcmVmaXgsXG4gIHJlc29sdmVRdWV1ZU5hbWVzcGFjZSxcbiAgdHlwZSBWYWxpZFF1ZXVlTmFtZSxcbiAgV29ya2Zsb3dJbnZva2VQYXlsb2FkU2NoZW1hLFxufSBmcm9tICdAd29ya2Zsb3cvd29ybGQnO1xuaW1wb3J0IHsgY3JlYXRlV29ybGQgfSBmcm9tICdAd29ya2Zsb3cvd29ybGQtbG9jYWwnO1xuaW1wb3J0IHtcbiAgTG9nZ2VyLFxuICBtYWtlV29ya2VyVXRpbHMsXG4gIHR5cGUgUnVubmVyLFxuICBydW4sXG4gIHR5cGUgV29ya2VyVXRpbHMsXG59IGZyb20gJ2dyYXBoaWxlLXdvcmtlcic7XG5pbXBvcnQgdHlwZSB7IFBvb2wgfSBmcm9tICdwZyc7XG5pbXBvcnQgeyBtb25vdG9uaWNGYWN0b3J5IH0gZnJvbSAndWxpZCc7XG5pbXBvcnQgeyB6IH0gZnJvbSAnem9kL3Y0JztcbmltcG9ydCB0eXBlIHsgUG9zdGdyZXNXb3JsZENvbmZpZyB9IGZyb20gJy4vY29uZmlnLmpzJztcbmltcG9ydCB7IE1lc3NhZ2VEYXRhIH0gZnJvbSAnLi9tZXNzYWdlLmpzJztcblxuZnVuY3Rpb24gY3JlYXRlR3JhcGhpbGVMb2dnZXIoKSB7XG4gIGNvbnN0IGlzSnNvbk1vZGUgPSAoKSA9PiBwcm9jZXNzLmVudi5XT1JLRkxPV19KU09OX01PREUgPT09ICcxJztcbiAgY29uc3QgaXNWZXJib3NlID0gKCkgPT4gQm9vbGVhbihwcm9jZXNzLmVudi5ERUJVRyk7XG5cbiAgcmV0dXJuIG5ldyBMb2dnZXIoKCkgPT4gKGxldmVsOiBzdHJpbmcsIG1lc3NhZ2U6IHN0cmluZywgbWV0YT86IHVua25vd24pID0+IHtcbiAgICBpZiAoaXNKc29uTW9kZSgpKSByZXR1cm47XG4gICAgaWYgKChsZXZlbCA9PT0gJ2RlYnVnJyB8fCBsZXZlbCA9PT0gJ2luZm8nKSAmJiAhaXNWZXJib3NlKCkpIHJldHVybjtcbiAgICBjb25zdCBwaXBlID0gbGV2ZWwgPT09ICdlcnJvcicgPyBwcm9jZXNzLnN0ZGVyciA6IHByb2Nlc3Muc3Rkb3V0O1xuICAgIGlmIChtZXRhKSB7XG4gICAgICBwaXBlLndyaXRlKFxuICAgICAgICBgW0dyYXBoaWxlIFdvcmtlcl0gJHttZXNzYWdlfSAke0pTT04uc3RyaW5naWZ5KG1ldGEsIG51bGwsIDIpfVxcbmBcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHBpcGUud3JpdGUoYFtHcmFwaGlsZSBXb3JrZXJdICR7bWVzc2FnZX1cXG5gKTtcbiAgICB9XG4gIH0pO1xufVxuXG5jb25zdCBncmFwaGlsZUxvZ2dlciA9IGNyZWF0ZUdyYXBoaWxlTG9nZ2VyKCk7XG5jb25zdCBDT01QTEVURURfSURFTVBPVEVOQ1lfQ0FDSEVfTElNSVQgPSAxMF8wMDA7XG4vLyBDb3JlIHJlY29yZHMgTUFYX0RFTElWRVJJRVNfRVhDRUVERUQgb24gZGVsaXZlcnkgNDkuXG5jb25zdCBNQVhfR1JBUEhJTEVfSk9CX0FUVEVNUFRTID0gNDk7XG5jb25zdCBHcmFwaGlsZUhlbHBlcnMgPSB6Lm9iamVjdCh7XG4gIGFib3J0U2lnbmFsOiB6Lmluc3RhbmNlb2YoQWJvcnRTaWduYWwpLm9wdGlvbmFsKCksXG4gIGpvYjogei5vYmplY3Qoe1xuICAgIGF0dGVtcHRzOiB6Lm51bWJlcigpLmludCgpLnBvc2l0aXZlKCksXG4gIH0pLFxufSk7XG5cbnR5cGUgSHR0cEV4ZWN1dGlvblJlc3VsdCA9XG4gIHwgeyB0eXBlOiAnY29tcGxldGVkJyB9XG4gIHwgeyB0eXBlOiAncmVzY2hlZHVsZSc7IHRpbWVvdXRTZWNvbmRzOiBudW1iZXIgfVxuICB8IHtcbiAgICAgIHR5cGU6ICdlcnJvcic7XG4gICAgICBzdGF0dXM6IG51bWJlcjtcbiAgICAgIHRleHQ6IHN0cmluZztcbiAgICAgIGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgfTtcblxudHlwZSBSdW5uZXJTdGFydCA9IHsgY29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyOyBwcm9taXNlOiBQcm9taXNlPHZvaWQ+IH07XG50eXBlIExvb3BiYWNrVGFyZ2V0ID0geyBob3N0czogc3RyaW5nW107IHBvcnQ6IG51bWJlciB9O1xuXG4vKipcbiAqIFRoZSBQb3N0Z3JlcyBxdWV1ZSBzdG9yZXMgbWVzc2FnZXMgdW5kZXIgb25lIGdyYXBoaWxlLXdvcmtlciBmbG93IHRhc2suXG4gKi9cbmV4cG9ydCB0eXBlIFBvc3RncmVzUXVldWUgPSBRdWV1ZSAmIHtcbiAgc3RhcnQoKTogUHJvbWlzZTx2b2lkPjtcbiAgY2xvc2UoKTogUHJvbWlzZTx2b2lkPjtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVRdWV1ZShcbiAgY29uZmlnOiBQb3N0Z3Jlc1dvcmxkQ29uZmlnLFxuICBwb29sOiBQb29sXG4pOiBQb3N0Z3Jlc1F1ZXVlIHtcbiAgY29uc3QgcG9ydCA9IHByb2Nlc3MuZW52LlBPUlQgPyBOdW1iZXIocHJvY2Vzcy5lbnYuUE9SVCkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGxvY2FsV29ybGQgPSBjcmVhdGVXb3JsZCh7IGRhdGFEaXI6IHVuZGVmaW5lZCwgcG9ydCB9KTtcblxuICAvLyBKU09OIHRyYW5zcG9ydCB0aGF0IHByZXNlcnZlcyBVaW50OEFycmF5IHZhbHVlcyB2aWEgYSB0YWdnZWRcbiAgLy8gZW52ZWxvcGUgKHsgX190eXBlOiAnVWludDhBcnJheScsIGRhdGE6ICc8YmFzZTY0PicgfSkuICBSZXF1aXJlZFxuICAvLyBmb3IgdGhlIHJlc2lsaWVudCBzdGFydCBwYXRoIHdoZXJlIHJ1bklucHV0LmlucHV0IChhIFVpbnQ4QXJyYXkpXG4gIC8vIGlzIHNlbnQgdGhyb3VnaCB0aGUgcXVldWUuXG4gIGNvbnN0IHRyYW5zcG9ydDogVHJhbnNwb3J0PHVua25vd24+ID0ge1xuICAgIGNvbnRlbnRUeXBlOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgc2VyaWFsaXplKHZhbHVlOiB1bmtub3duKTogQnVmZmVyIHtcbiAgICAgIHJldHVybiBCdWZmZXIuZnJvbShcbiAgICAgICAgSlNPTi5zdHJpbmdpZnkodmFsdWUsIChfa2V5LCB2KSA9PlxuICAgICAgICAgIHYgaW5zdGFuY2VvZiBVaW50OEFycmF5XG4gICAgICAgICAgICA/IHsgX190eXBlOiAnVWludDhBcnJheScsIGRhdGE6IEJ1ZmZlci5mcm9tKHYpLnRvU3RyaW5nKCdiYXNlNjQnKSB9XG4gICAgICAgICAgICA6IHZcbiAgICAgICAgKVxuICAgICAgKTtcbiAgICB9LFxuICAgIGFzeW5jIGRlc2VyaWFsaXplKHN0cmVhbTogUmVhZGFibGVTdHJlYW08VWludDhBcnJheT4pOiBQcm9taXNlPHVua25vd24+IHtcbiAgICAgIGNvbnN0IGNodW5rczogVWludDhBcnJheVtdID0gW107XG4gICAgICBjb25zdCByZWFkZXIgPSBzdHJlYW0uZ2V0UmVhZGVyKCk7XG4gICAgICBmb3IgKDs7KSB7XG4gICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgICAgaWYgKHZhbHVlKSBjaHVua3MucHVzaCh2YWx1ZSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoKSwgKF9rZXksIHYpID0+XG4gICAgICAgIHYgIT09IG51bGwgJiZcbiAgICAgICAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmXG4gICAgICAgIHYuX190eXBlID09PSAnVWludDhBcnJheScgJiZcbiAgICAgICAgdHlwZW9mIHYuZGF0YSA9PT0gJ3N0cmluZydcbiAgICAgICAgICA/IG5ldyBVaW50OEFycmF5KEJ1ZmZlci5mcm9tKHYuZGF0YSwgJ2Jhc2U2NCcpKVxuICAgICAgICAgIDogdlxuICAgICAgKTtcbiAgICB9LFxuICB9O1xuICBjb25zdCBnZW5lcmF0ZU1lc3NhZ2VJZCA9IG1vbm90b25pY0ZhY3RvcnkoKTtcblxuICBmdW5jdGlvbiBnZXRKb2JRdWV1ZU5hbWUoKTogc3RyaW5nIHtcbiAgICBjb25zdCBqb2JQcmVmaXggPSBjb25maWcuam9iUHJlZml4IHx8ICd3b3JrZmxvd18nO1xuICAgIHJldHVybiBgJHtqb2JQcmVmaXh9Zmxvd3NgO1xuICB9XG5cbiAgY29uc3QgY3JlYXRlUXVldWVIYW5kbGVyID0gbG9jYWxXb3JsZC5jcmVhdGVRdWV1ZUhhbmRsZXI7XG5cbiAgY29uc3QgZ2V0RGVwbG95bWVudElkOiBRdWV1ZVsnZ2V0RGVwbG95bWVudElkJ10gPSBhc3luYyAoKSA9PiB7XG4gICAgcmV0dXJuICdwb3N0Z3Jlcyc7XG4gIH07XG5cbiAgY29uc3QgY29tcGxldGVkTWVzc2FnZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgaW5mbGlnaHRNZXNzYWdlcyA9IG5ldyBNYXA8c3RyaW5nLCBQcm9taXNlPHZvaWQ+PigpO1xuICBjb25zdCBpbmZsaWdodFdvcmtmbG93UnVucyA9IG5ldyBNYXA8XG4gICAgc3RyaW5nLFxuICAgIFByb21pc2U8J2NvbXBsZXRlZCcgfCAncmVzY2hlZHVsZWQnPlxuICA+KCk7XG4gIGxldCB3b3JrZXJVdGlsczogV29ya2VyVXRpbHMgfCBudWxsID0gbnVsbDtcbiAgbGV0IHJ1bm5lcjogUnVubmVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCBydW5uZXJTdGFydDogUnVubmVyU3RhcnQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NpbmcgPSBmYWxzZTtcbiAgbGV0IHN0YXJ0UHJvbWlzZTogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuXG4gIGZ1bmN0aW9uIG1hcmtNZXNzYWdlQ29tcGxldGVkKGlkZW1wb3RlbmN5S2V5OiBzdHJpbmcpIHtcbiAgICBjb21wbGV0ZWRNZXNzYWdlcy5kZWxldGUoaWRlbXBvdGVuY3lLZXkpO1xuICAgIGNvbXBsZXRlZE1lc3NhZ2VzLmFkZChpZGVtcG90ZW5jeUtleSk7XG4gICAgaWYgKGNvbXBsZXRlZE1lc3NhZ2VzLnNpemUgPiBDT01QTEVURURfSURFTVBPVEVOQ1lfQ0FDSEVfTElNSVQpIHtcbiAgICAgIGNvbnN0IG9sZGVzdEtleSA9IGNvbXBsZXRlZE1lc3NhZ2VzLnZhbHVlcygpLm5leHQoKS52YWx1ZTtcbiAgICAgIGlmIChvbGRlc3RLZXkpIHtcbiAgICAgICAgY29tcGxldGVkTWVzc2FnZXMuZGVsZXRlKG9sZGVzdEtleSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gYWRkR3JhcGhpbGVKb2Ioe1xuICAgIHF1ZXVlSWQsXG4gICAgYm9keSxcbiAgICBtZXNzYWdlSWQsXG4gICAgYXR0ZW1wdCxcbiAgICBpZGVtcG90ZW5jeUtleSxcbiAgICBoZWFkZXJzLFxuICAgIGRlbGF5U2Vjb25kcyxcbiAgICBqb2JLZXksXG4gIH06IHtcbiAgICBxdWV1ZUlkOiBzdHJpbmc7XG4gICAgYm9keTogQnVmZmVyIHwgVWludDhBcnJheTtcbiAgICBtZXNzYWdlSWQ6IE1lc3NhZ2VJZDtcbiAgICBhdHRlbXB0OiBudW1iZXI7XG4gICAgaWRlbXBvdGVuY3lLZXk/OiBzdHJpbmc7XG4gICAgaGVhZGVycz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gICAgZGVsYXlTZWNvbmRzPzogbnVtYmVyO1xuICAgIGpvYktleT86IHN0cmluZztcbiAgfSkge1xuICAgIGNvbnN0IHV0aWxzID0gd29ya2VyVXRpbHM7XG4gICAgaWYgKCF1dGlscykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdQb3N0Z3JlcyBxdWV1ZSB3b3JrZXIgdXRpbHMgYXJlIG5vdCBpbml0aWFsaXplZCcpO1xuICAgIH1cblxuICAgIGNvbnN0IHJ1bkF0ID1cbiAgICAgIHR5cGVvZiBkZWxheVNlY29uZHMgPT09ICdudW1iZXInICYmIGRlbGF5U2Vjb25kcyA+IDBcbiAgICAgICAgPyBuZXcgRGF0ZShEYXRlLm5vdygpICsgZGVsYXlTZWNvbmRzICogMTAwMClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICBhd2FpdCB1dGlscy5hZGRKb2IoXG4gICAgICBnZXRKb2JRdWV1ZU5hbWUoKSxcbiAgICAgIE1lc3NhZ2VEYXRhLmVuY29kZSh7XG4gICAgICAgIGlkOiBxdWV1ZUlkLFxuICAgICAgICBkYXRhOiBCdWZmZXIuZnJvbShib2R5KSxcbiAgICAgICAgYXR0ZW1wdCxcbiAgICAgICAgbWVzc2FnZUlkLFxuICAgICAgICBpZGVtcG90ZW5jeUtleSxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgIH0pLFxuICAgICAge1xuICAgICAgICAuLi4oam9iS2V5ID8geyBqb2JLZXkgfSA6IHt9KSxcbiAgICAgICAgLi4uKHJ1bkF0ID8geyBydW5BdCB9IDoge30pLFxuICAgICAgICBtYXhBdHRlbXB0czogTUFYX0dSQVBISUxFX0pPQl9BVFRFTVBUUyxcbiAgICAgIH1cbiAgICApO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gZ2V0RXhlY3V0aW9uQmFzZVVybCgpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuICAgIGlmIChwcm9jZXNzLmVudi5XT1JLRkxPV19MT0NBTF9CQVNFX1VSTCkge1xuICAgICAgcmV0dXJuIHByb2Nlc3MuZW52LldPUktGTE9XX0xPQ0FMX0JBU0VfVVJMO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgcG9ydCA9PT0gJ251bWJlcicpIHtcbiAgICAgIHJldHVybiBjcmVhdGVXb3JrZmxvd0Jhc2VVcmwoYGh0dHA6Ly9sb2NhbGhvc3Q6JHtwb3J0fWApO1xuICAgIH1cblxuICAgIGlmIChwcm9jZXNzLmVudi5QT1JUKSB7XG4gICAgICByZXR1cm4gY3JlYXRlV29ya2Zsb3dCYXNlVXJsKGBodHRwOi8vbG9jYWxob3N0OiR7cHJvY2Vzcy5lbnYuUE9SVH1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBkZXRlY3RlZFBvcnQgPSBhd2FpdCBnZXRXb3JrZmxvd1BvcnQoe1xuICAgICAgZW5kcG9pbnQ6IGNyZWF0ZVdvcmtmbG93SGVhbHRoRW5kcG9pbnQoKSxcbiAgICB9KTtcbiAgICBpZiAodHlwZW9mIGRldGVjdGVkUG9ydCA9PT0gJ251bWJlcicpIHtcbiAgICAgIHJldHVybiBjcmVhdGVXb3JrZmxvd0Jhc2VVcmwoYGh0dHA6Ly9sb2NhbGhvc3Q6JHtkZXRlY3RlZFBvcnR9YCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldExvb3BiYWNrSG9zdHMoaG9zdG5hbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICBpZiAoaG9zdG5hbWUgPT09ICdsb2NhbGhvc3QnKSB7XG4gICAgICByZXR1cm4gWycxMjcuMC4wLjEnLCAnOjoxJ107XG4gICAgfVxuICAgIGlmIChob3N0bmFtZSA9PT0gJ1s6OjFdJykge1xuICAgICAgcmV0dXJuIFsnOjoxJ107XG4gICAgfVxuICAgIHJldHVybiBob3N0bmFtZSA9PT0gJzEyNy4wLjAuMScgfHwgaG9zdG5hbWUgPT09ICc6OjEnID8gW2hvc3RuYW1lXSA6IFtdO1xuICB9XG5cbiAgZnVuY3Rpb24gZ2V0TG9vcGJhY2tUYXJnZXQoYmFzZVVybDogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFiYXNlVXJsKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwoYmFzZVVybCk7XG4gICAgY29uc3QgaG9zdHMgPSBnZXRMb29wYmFja0hvc3RzKHVybC5ob3N0bmFtZSk7XG4gICAgaWYgKGhvc3RzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgaG9zdHMsXG4gICAgICBwb3J0OiBOdW1iZXIodXJsLnBvcnQgfHwgKHVybC5wcm90b2NvbCA9PT0gJ2h0dHBzOicgPyA0NDMgOiA4MCkpLFxuICAgIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjYW5Db25uZWN0VG9Mb29wYmFja1RhcmdldChcbiAgICB0YXJnZXQ6IExvb3BiYWNrVGFyZ2V0XG4gICk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIGZvciAoY29uc3QgaG9zdCBvZiB0YXJnZXQuaG9zdHMpIHtcbiAgICAgIGNvbnN0IHJlYWNoYWJsZSA9IGF3YWl0IG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGNvbnN0IHNvY2tldCA9IGNvbm5lY3QoeyBob3N0LCBwb3J0OiB0YXJnZXQucG9ydCB9KTtcbiAgICAgICAgc29ja2V0LnVucmVmKCk7XG4gICAgICAgIGNvbnN0IGZpbmlzaCA9IChpc1JlYWNoYWJsZTogYm9vbGVhbikgPT4ge1xuICAgICAgICAgIHNvY2tldC5kZXN0cm95KCk7XG4gICAgICAgICAgcmVzb2x2ZShpc1JlYWNoYWJsZSk7XG4gICAgICAgIH07XG5cbiAgICAgICAgc29ja2V0LnNldFRpbWVvdXQoMjAwLCAoKSA9PiBmaW5pc2goZmFsc2UpKTtcbiAgICAgICAgc29ja2V0Lm9uY2UoJ2Nvbm5lY3QnLCAoKSA9PiBmaW5pc2godHJ1ZSkpO1xuICAgICAgICBzb2NrZXQub25jZSgnZXJyb3InLCAoKSA9PiBmaW5pc2goZmFsc2UpKTtcbiAgICAgIH0pO1xuXG4gICAgICBpZiAocmVhY2hhYmxlKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHN0YXJ0UnVubmVyVW5sZXNzQWJvcnRlZChjb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIpIHtcbiAgICBpZiAoY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGF3YWl0IHNldHVwTGlzdGVuZXJzKCk7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiB3YWl0Rm9yTG9vcGJhY2tBbmRTdGFydFJ1bm5lcihcbiAgICBjb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIsXG4gICAgdGFyZ2V0OiBMb29wYmFja1RhcmdldFxuICApIHtcbiAgICB3aGlsZSAoXG4gICAgICAhY29udHJvbGxlci5zaWduYWwuYWJvcnRlZCAmJlxuICAgICAgIShhd2FpdCBjYW5Db25uZWN0VG9Mb29wYmFja1RhcmdldCh0YXJnZXQpKVxuICAgICkge1xuICAgICAgYXdhaXQgc2xlZXAoNTAsIHVuZGVmaW5lZCwge1xuICAgICAgICByZWY6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgYXdhaXQgc3RhcnRSdW5uZXJVbmxlc3NBYm9ydGVkKGNvbnRyb2xsZXIpO1xuICB9XG5cbiAgZnVuY3Rpb24gZGVmZXJSdW5uZXJTdGFydChcbiAgICBjb250cm9sbGVyOiBBYm9ydENvbnRyb2xsZXIsXG4gICAgdGFyZ2V0OiBMb29wYmFja1RhcmdldFxuICApIHtcbiAgICBjb25zdCBwcm9taXNlID0gd2FpdEZvckxvb3BiYWNrQW5kU3RhcnRSdW5uZXIoY29udHJvbGxlciwgdGFyZ2V0KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgaWYgKCFjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgICAgJ1t3b3JsZC1wb3N0Z3Jlc10gRmFpbGVkIHRvIHN0YXJ0IEdyYXBoaWxlIFdvcmtlciBhZnRlciBsb2NhbCB3b3JrZmxvdyBleGVjdXRvciBiZWNhbWUgcmVhY2hhYmxlOicsXG4gICAgICAgICAgICBlcnJcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICBpZiAocnVubmVyU3RhcnQ/LnByb21pc2UgPT09IHByb21pc2UpIHtcbiAgICAgICAgICBydW5uZXJTdGFydCA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIHJ1bm5lclN0YXJ0ID0geyBjb250cm9sbGVyLCBwcm9taXNlIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBleGVjdXRlTWVzc2FnZU92ZXJIdHRwKHtcbiAgICBxdWV1ZU5hbWUsXG4gICAgbWVzc2FnZUlkLFxuICAgIGF0dGVtcHQsXG4gICAgYm9keSxcbiAgICBoZWFkZXJzOiBleHRyYUhlYWRlcnMsXG4gICAgYWJvcnRTaWduYWwsXG4gIH06IHtcbiAgICBxdWV1ZU5hbWU6IFZhbGlkUXVldWVOYW1lO1xuICAgIG1lc3NhZ2VJZDogTWVzc2FnZUlkO1xuICAgIGF0dGVtcHQ6IG51bWJlcjtcbiAgICBib2R5OiBVaW50OEFycmF5O1xuICAgIGhlYWRlcnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIGFib3J0U2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIH0pOiBQcm9taXNlPEh0dHBFeGVjdXRpb25SZXN1bHQ+IHtcbiAgICBjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgLi4uZXh0cmFIZWFkZXJzLFxuICAgICAgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICd4LXZxcy1xdWV1ZS1uYW1lJzogcXVldWVOYW1lLFxuICAgICAgJ3gtdnFzLW1lc3NhZ2UtaWQnOiBtZXNzYWdlSWQsXG4gICAgICAneC12cXMtbWVzc2FnZS1hdHRlbXB0JzogU3RyaW5nKGF0dGVtcHQpLFxuICAgIH07XG4gICAgY29uc3QgYmFzZVVybCA9IGF3YWl0IGdldEV4ZWN1dGlvbkJhc2VVcmwoKTtcbiAgICBpZiAoIWJhc2VVcmwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignVW5hYmxlIHRvIHJlc29sdmUgYmFzZSBVUkwgZm9yIHdvcmtmbG93IHF1ZXVlLicpO1xuICAgIH1cbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGNyZWF0ZVdvcmtmbG93VXJsKGJhc2VVcmwsIHsgdHlwZTogJ2Zsb3cnIH0pLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGR1cGxleDogJ2hhbGYnLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHksXG4gICAgICBzaWduYWw6IGFib3J0U2lnbmFsLFxuICAgIH0gYXMgYW55KTtcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogJ2Vycm9yJyxcbiAgICAgICAgc3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXG4gICAgICAgIHRleHQsXG4gICAgICAgIGhlYWRlcnM6IE9iamVjdC5mcm9tRW50cmllcyhyZXNwb25zZS5oZWFkZXJzLmVudHJpZXMoKSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBjb25zdCB0aW1lb3V0U2Vjb25kcyA9IE51bWJlcihKU09OLnBhcnNlKHRleHQpLnRpbWVvdXRTZWNvbmRzKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUodGltZW91dFNlY29uZHMpICYmIHRpbWVvdXRTZWNvbmRzID49IDApIHtcbiAgICAgICAgcmV0dXJuIHsgdHlwZTogJ3Jlc2NoZWR1bGUnLCB0aW1lb3V0U2Vjb25kcyB9O1xuICAgICAgfVxuICAgIH0gY2F0Y2gge31cblxuICAgIHJldHVybiB7IHR5cGU6ICdjb21wbGV0ZWQnIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBtaWdyYXRlUGdCb3NzSm9icyh1dGlsczogV29ya2VyVXRpbHMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBTY2VuYXJpbyBBOiBEcml6emxlIG1pZ3JhdGlvbiBhbHJlYWR5IHJhbiDigJQgc3RhZ2luZyB0YWJsZSBleGlzdHNcbiAgICBjb25zdCBoYXNTdGFnaW5nID0gYXdhaXQgcG9vbC5xdWVyeShcbiAgICAgIGBTRUxFQ1QgRVhJU1RTIChcbiAgICAgICAgU0VMRUNUIDEgRlJPTSBpbmZvcm1hdGlvbl9zY2hlbWEudGFibGVzXG4gICAgICAgIFdIRVJFIHRhYmxlX3NjaGVtYSA9ICd3b3JrZmxvdydcbiAgICAgICAgQU5EIHRhYmxlX25hbWUgPSAnX3BnYm9zc19wZW5kaW5nX2pvYnMnXG4gICAgICApIEFTIGV4aXN0c2BcbiAgICApO1xuICAgIGlmIChoYXNTdGFnaW5nLnJvd3NbMF0/LmV4aXN0cykge1xuICAgICAgY29uc3Qgam9icyA9IGF3YWl0IHBvb2wucXVlcnkoXG4gICAgICAgIGBTRUxFQ1QgbmFtZSwgZGF0YSwgc2luZ2xldG9uX2tleSwgcmV0cnlfbGltaXRcbiAgICAgICAgRlJPTSBcIndvcmtmbG93XCIuXCJfcGdib3NzX3BlbmRpbmdfam9ic1wiYFxuICAgICAgKTtcbiAgICAgIGZvciAoY29uc3Qgam9iIG9mIGpvYnMucm93cykge1xuICAgICAgICBhd2FpdCB1dGlscy5hZGRKb2Ioam9iLm5hbWUsIGpvYi5kYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCB7XG4gICAgICAgICAgam9iS2V5OiBqb2Iuc2luZ2xldG9uX2tleSA/PyB1bmRlZmluZWQsXG4gICAgICAgICAgbWF4QXR0ZW1wdHM6IE1hdGgubWF4KFxuICAgICAgICAgICAgam9iLnJldHJ5X2xpbWl0ID8/IDAsXG4gICAgICAgICAgICBNQVhfR1JBUEhJTEVfSk9CX0FUVEVNUFRTXG4gICAgICAgICAgKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBhd2FpdCBwb29sLnF1ZXJ5KGBEUk9QIFRBQkxFIFwid29ya2Zsb3dcIi5cIl9wZ2Jvc3NfcGVuZGluZ19qb2JzXCJgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBTY2VuYXJpbyBCOiBEcml6emxlIG1pZ3JhdGlvbiBkaWRuJ3QgcnVuIOKAlCBwZ2Jvc3Mgc2NoZW1hIHN0aWxsIGV4aXN0c1xuICAgIGNvbnN0IGhhc1BnQm9zcyA9IGF3YWl0IHBvb2wucXVlcnkoXG4gICAgICBgU0VMRUNUIEVYSVNUUyAoXG4gICAgICAgIFNFTEVDVCAxIEZST00gaW5mb3JtYXRpb25fc2NoZW1hLnNjaGVtYXRhXG4gICAgICAgIFdIRVJFIHNjaGVtYV9uYW1lID0gJ3BnYm9zcydcbiAgICAgICkgQVMgZXhpc3RzYFxuICAgICk7XG4gICAgaWYgKGhhc1BnQm9zcy5yb3dzWzBdPy5leGlzdHMpIHtcbiAgICAgIGNvbnN0IGpvYnMgPSBhd2FpdCBwb29sLnF1ZXJ5KFxuICAgICAgICBgU0VMRUNUIG5hbWUsIGRhdGEsIHNpbmdsZXRvbl9rZXksIHJldHJ5X2xpbWl0XG4gICAgICAgIEZST00gcGdib3NzLmpvYlxuICAgICAgICBXSEVSRSBzdGF0ZSBJTiAoJ2NyZWF0ZWQnLCAncmV0cnknKWBcbiAgICAgICk7XG4gICAgICBmb3IgKGNvbnN0IGpvYiBvZiBqb2JzLnJvd3MpIHtcbiAgICAgICAgYXdhaXQgdXRpbHMuYWRkSm9iKGpvYi5uYW1lLCBqb2IuZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwge1xuICAgICAgICAgIGpvYktleTogam9iLnNpbmdsZXRvbl9rZXkgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgIG1heEF0dGVtcHRzOiBNYXRoLm1heChcbiAgICAgICAgICAgIGpvYi5yZXRyeV9saW1pdCA/PyAwLFxuICAgICAgICAgICAgTUFYX0dSQVBISUxFX0pPQl9BVFRFTVBUU1xuICAgICAgICAgICksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgYXdhaXQgcG9vbC5xdWVyeShgRFJPUCBTQ0hFTUEgcGdib3NzIENBU0NBREVgKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBzdGFydFJ1bm5lcldoZW5FeGVjdXRvcklzUmVhZHkoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKGNsb3NpbmcgfHwgcnVubmVyIHx8IHJ1bm5lclN0YXJ0KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBjb25zdCBwcm9taXNlID0gKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGdldExvb3BiYWNrVGFyZ2V0KGF3YWl0IGdldEV4ZWN1dGlvbkJhc2VVcmwoKSk7XG4gICAgICBpZiAoIXRhcmdldCkge1xuICAgICAgICBhd2FpdCBzdGFydFJ1bm5lclVubGVzc0Fib3J0ZWQoY29udHJvbGxlcik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKGF3YWl0IGNhbkNvbm5lY3RUb0xvb3BiYWNrVGFyZ2V0KHRhcmdldCkpIHtcbiAgICAgICAgYXdhaXQgc3RhcnRSdW5uZXJVbmxlc3NBYm9ydGVkKGNvbnRyb2xsZXIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgZGVmZXJSdW5uZXJTdGFydChjb250cm9sbGVyLCB0YXJnZXQpO1xuICAgIH0pKCkuZmluYWxseSgoKSA9PiB7XG4gICAgICBpZiAocnVubmVyU3RhcnQ/LnByb21pc2UgPT09IHByb21pc2UpIHtcbiAgICAgICAgcnVubmVyU3RhcnQgPSBudWxsO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHJ1bm5lclN0YXJ0ID0geyBjb250cm9sbGVyLCBwcm9taXNlIH07XG4gICAgYXdhaXQgcHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIHN0YXJ0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChjbG9zaW5nKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCFzdGFydFByb21pc2UpIHtcbiAgICAgIHN0YXJ0UHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgd29ya2VyVXRpbHMgPSBhd2FpdCBtYWtlV29ya2VyVXRpbHMoe1xuICAgICAgICAgICAgcGdQb29sOiBwb29sLFxuICAgICAgICAgICAgbG9nZ2VyOiBncmFwaGlsZUxvZ2dlcixcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBhd2FpdCB3b3JrZXJVdGlscy5taWdyYXRlKCk7XG4gICAgICAgICAgYXdhaXQgbWlncmF0ZVBnQm9zc0pvYnMod29ya2VyVXRpbHMpO1xuICAgICAgICAgIGF3YWl0IHN0YXJ0UnVubmVyV2hlbkV4ZWN1dG9ySXNSZWFkeSgpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBzdGFydFByb21pc2UgPSBudWxsO1xuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICB9XG4gICAgYXdhaXQgc3RhcnRQcm9taXNlO1xuICAgIGlmICghY2xvc2luZyAmJiAhcnVubmVyICYmICFydW5uZXJTdGFydCkge1xuICAgICAgYXdhaXQgc3RhcnRSdW5uZXJXaGVuRXhlY3V0b3JJc1JlYWR5KCk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcXVldWU6IFF1ZXVlWydxdWV1ZSddID0gYXN5bmMgKHF1ZXVlLCBtZXNzYWdlLCBvcHRzKSA9PiB7XG4gICAgYXdhaXQgc3RhcnQoKTtcbiAgICBjb25zdCB7IGlkOiBxdWV1ZUlkIH0gPSBwYXJzZVF1ZXVlTmFtZShxdWV1ZSk7XG4gICAgY29uc3QgYm9keSA9IHRyYW5zcG9ydC5zZXJpYWxpemUobWVzc2FnZSkgYXMgQnVmZmVyO1xuICAgIGNvbnN0IG1lc3NhZ2VJZCA9IE1lc3NhZ2VJZC5wYXJzZShgbXNnXyR7Z2VuZXJhdGVNZXNzYWdlSWQoKX1gKTtcbiAgICBhd2FpdCBhZGRHcmFwaGlsZUpvYih7XG4gICAgICBxdWV1ZUlkLFxuICAgICAgYm9keSxcbiAgICAgIG1lc3NhZ2VJZCxcbiAgICAgIGF0dGVtcHQ6IDEsXG4gICAgICBpZGVtcG90ZW5jeUtleTogb3B0cz8uaWRlbXBvdGVuY3lLZXksXG4gICAgICBoZWFkZXJzOiBvcHRzPy5oZWFkZXJzLFxuICAgICAgZGVsYXlTZWNvbmRzOiBvcHRzPy5kZWxheVNlY29uZHMsXG4gICAgICBqb2JLZXk6IG9wdHM/LmlkZW1wb3RlbmN5S2V5ID8/IG1lc3NhZ2VJZCxcbiAgICB9KTtcbiAgICByZXR1cm4geyBtZXNzYWdlSWQgfTtcbiAgfTtcblxuICBhc3luYyBmdW5jdGlvbiBkZXNlcmlhbGl6ZU1lc3NhZ2VCb2R5KGRhdGE6IEJ1ZmZlcik6IFByb21pc2U8dW5rbm93bj4ge1xuICAgIGNvbnN0IGJvZHlTdHJlYW0gPSBTdHJlYW0uUmVhZGFibGUudG9XZWIoU3RyZWFtLlJlYWRhYmxlLmZyb20oW2RhdGFdKSk7XG4gICAgcmV0dXJuIHRyYW5zcG9ydC5kZXNlcmlhbGl6ZShib2R5U3RyZWFtIGFzIFJlYWRhYmxlU3RyZWFtPFVpbnQ4QXJyYXk+KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZVRhc2tIYW5kbGVyKHF1ZXVlOiBRdWV1ZVByZWZpeCkge1xuICAgIHJldHVybiBhc3luYyAocGF5bG9hZDogdW5rbm93biwgaGVscGVyczogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbWVzc2FnZURhdGEgPSBNZXNzYWdlRGF0YS5wYXJzZShwYXlsb2FkKTtcbiAgICAgIGNvbnN0IGdyYXBoaWxlSGVscGVycyA9IEdyYXBoaWxlSGVscGVycy5zYWZlUGFyc2UoaGVscGVycyk7XG4gICAgICBjb25zdCBhdHRlbXB0ID0gZ3JhcGhpbGVIZWxwZXJzLnN1Y2Nlc3NcbiAgICAgICAgPyBncmFwaGlsZUhlbHBlcnMuZGF0YS5qb2IuYXR0ZW1wdHNcbiAgICAgICAgOiBtZXNzYWdlRGF0YS5hdHRlbXB0O1xuICAgICAgY29uc3QgcXVldWVOYW1lID0gYCR7cXVldWV9JHttZXNzYWdlRGF0YS5pZH1gIGFzIFZhbGlkUXVldWVOYW1lO1xuICAgICAgY29uc3QgYm9keSA9IGF3YWl0IGRlc2VyaWFsaXplTWVzc2FnZUJvZHkobWVzc2FnZURhdGEuZGF0YSk7XG4gICAgICBRdWV1ZVBheWxvYWRTY2hlbWEucGFyc2UoYm9keSk7XG4gICAgICBjb25zdCB3b3JrZmxvd0ludm9rZSA9IFdvcmtmbG93SW52b2tlUGF5bG9hZFNjaGVtYS5zYWZlUGFyc2UoYm9keSk7XG4gICAgICBjb25zdCB3b3JrZmxvd1J1blNlcmlhbGl6YXRpb25LZXkgPVxuICAgICAgICB3b3JrZmxvd0ludm9rZS5zdWNjZXNzICYmICF3b3JrZmxvd0ludm9rZS5kYXRhLnN0ZXBJZFxuICAgICAgICAgID8gYHdvcmtmbG93OiR7d29ya2Zsb3dJbnZva2UuZGF0YS5ydW5JZH1gXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBleGVjdXRlVGFzayA9IGFzeW5jICgpOiBQcm9taXNlPCdjb21wbGV0ZWQnIHwgJ3Jlc2NoZWR1bGVkJz4gPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlTWVzc2FnZU92ZXJIdHRwKHtcbiAgICAgICAgICBxdWV1ZU5hbWUsXG4gICAgICAgICAgbWVzc2FnZUlkOiBtZXNzYWdlRGF0YS5tZXNzYWdlSWQsXG4gICAgICAgICAgYXR0ZW1wdCxcbiAgICAgICAgICBib2R5OiBtZXNzYWdlRGF0YS5kYXRhLFxuICAgICAgICAgIGhlYWRlcnM6IG1lc3NhZ2VEYXRhLmhlYWRlcnMsXG4gICAgICAgICAgYWJvcnRTaWduYWw6IGdyYXBoaWxlSGVscGVycy5zdWNjZXNzXG4gICAgICAgICAgICA/IGdyYXBoaWxlSGVscGVycy5kYXRhLmFib3J0U2lnbmFsXG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHJlc3VsdC50eXBlID09PSAnY29tcGxldGVkJykge1xuICAgICAgICAgIHJldHVybiAnY29tcGxldGVkJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXN1bHQudHlwZSA9PT0gJ3Jlc2NoZWR1bGUnKSB7XG4gICAgICAgICAgLy8gU2NoZWR1bGUgdGhlIGZvbGxvdy11cCBqb2IgYmVmb3JlIHdlIHJldHVybiBzbyBhIGNyYXNoIGNhbm5vdFxuICAgICAgICAgIC8vIGxvc2UgdGhlIHdha2UtdXAgcmVxdWVzdC5cbiAgICAgICAgICBhd2FpdCBhZGRHcmFwaGlsZUpvYih7XG4gICAgICAgICAgICBxdWV1ZUlkOiBtZXNzYWdlRGF0YS5pZCxcbiAgICAgICAgICAgIGJvZHk6IG1lc3NhZ2VEYXRhLmRhdGEsXG4gICAgICAgICAgICBtZXNzYWdlSWQ6IG1lc3NhZ2VEYXRhLm1lc3NhZ2VJZCxcbiAgICAgICAgICAgIGF0dGVtcHQ6IGF0dGVtcHQgKyAxLFxuICAgICAgICAgICAgaWRlbXBvdGVuY3lLZXk6IG1lc3NhZ2VEYXRhLmlkZW1wb3RlbmN5S2V5LFxuICAgICAgICAgICAgaGVhZGVyczogbWVzc2FnZURhdGEuaGVhZGVycyxcbiAgICAgICAgICAgIGRlbGF5U2Vjb25kczogcmVzdWx0LnRpbWVvdXRTZWNvbmRzLFxuICAgICAgICAgICAgam9iS2V5OiBtZXNzYWdlRGF0YS5pZGVtcG90ZW5jeUtleSA/PyBtZXNzYWdlRGF0YS5tZXNzYWdlSWQsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuICdyZXNjaGVkdWxlZCc7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYFtwb3N0Z3JlcyB3b3JsZF0gUXVldWUgZXhlY3V0aW9uIGZhaWxlZCAoJHtyZXN1bHQuc3RhdHVzfSk6ICR7cmVzdWx0LnRleHR9YFxuICAgICAgICApO1xuICAgICAgfTtcblxuICAgICAgY29uc3QgaWRlbXBvdGVuY3lLZXkgPSBtZXNzYWdlRGF0YS5pZGVtcG90ZW5jeUtleTtcbiAgICAgIGlmICghaWRlbXBvdGVuY3lLZXkpIHtcbiAgICAgICAgaWYgKHdvcmtmbG93UnVuU2VyaWFsaXphdGlvbktleSkge1xuICAgICAgICAgIC8vIFByZXNlcnZlIHN0ZXAgZmFuLW91dCB3aGlsZSBwcmV2ZW50aW5nIHR3byB3b3JrZmxvdyByZXBsYXlzIGZyb21cbiAgICAgICAgICAvLyBtdXRhdGluZyB0aGUgc2FtZSBydW4ncyBldmVudCBsb2cgYXQgdGhlIHNhbWUgdGltZS5cbiAgICAgICAgICBjb25zdCBwcmV2aW91cyA9IGluZmxpZ2h0V29ya2Zsb3dSdW5zLmdldChcbiAgICAgICAgICAgIHdvcmtmbG93UnVuU2VyaWFsaXphdGlvbktleVxuICAgICAgICAgICk7XG4gICAgICAgICAgY29uc3QgZXhlY3V0aW9uID0gKHByZXZpb3VzID8/IFByb21pc2UucmVzb2x2ZSgpKVxuICAgICAgICAgICAgLmNhdGNoKCgpID0+IHt9KVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4gZXhlY3V0ZVRhc2soKSlcbiAgICAgICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgIGluZmxpZ2h0V29ya2Zsb3dSdW5zLmdldCh3b3JrZmxvd1J1blNlcmlhbGl6YXRpb25LZXkpID09PVxuICAgICAgICAgICAgICAgIGV4ZWN1dGlvblxuICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICBpbmZsaWdodFdvcmtmbG93UnVucy5kZWxldGUod29ya2Zsb3dSdW5TZXJpYWxpemF0aW9uS2V5KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgaW5mbGlnaHRXb3JrZmxvd1J1bnMuc2V0KHdvcmtmbG93UnVuU2VyaWFsaXphdGlvbktleSwgZXhlY3V0aW9uKTtcbiAgICAgICAgICBhd2FpdCBleGVjdXRpb247XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgZXhlY3V0ZVRhc2soKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAoY29tcGxldGVkTWVzc2FnZXMuaGFzKGlkZW1wb3RlbmN5S2V5KSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGV4aXN0aW5nID0gaW5mbGlnaHRNZXNzYWdlcy5nZXQoaWRlbXBvdGVuY3lLZXkpO1xuICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgIGF3YWl0IGV4aXN0aW5nO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGV4ZWN1dGlvbiA9IGV4ZWN1dGVUYXNrKClcbiAgICAgICAgLnRoZW4oKHJlc3VsdCkgPT4ge1xuICAgICAgICAgIGlmIChyZXN1bHQgPT09ICdjb21wbGV0ZWQnKSB7XG4gICAgICAgICAgICBtYXJrTWVzc2FnZUNvbXBsZXRlZChpZGVtcG90ZW5jeUtleSk7XG4gICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgaW5mbGlnaHRNZXNzYWdlcy5kZWxldGUoaWRlbXBvdGVuY3lLZXkpO1xuICAgICAgICB9KTtcbiAgICAgIGluZmxpZ2h0TWVzc2FnZXMuc2V0KGlkZW1wb3RlbmN5S2V5LCBleGVjdXRpb24pO1xuICAgICAgYXdhaXQgZXhlY3V0aW9uO1xuICAgIH07XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBzZXR1cExpc3RlbmVycygpIHtcbiAgICBjb25zdCB0YXNrTGlzdDogUmVjb3JkPFxuICAgICAgc3RyaW5nLFxuICAgICAgKHBheWxvYWQ6IHVua25vd24sIGhlbHBlcnM6IHVua25vd24pID0+IFByb21pc2U8dm9pZD5cbiAgICA+ID0ge307XG4gICAgY29uc3QgbmFtZXNwYWNlID0gcmVzb2x2ZVF1ZXVlTmFtZXNwYWNlKGNvbmZpZy5uYW1lc3BhY2UpO1xuICAgIGNvbnN0IHdvcmtmbG93UHJlZml4ID0gZ2V0UXVldWVUb3BpY1ByZWZpeCgnd29ya2Zsb3cnLCBuYW1lc3BhY2UpO1xuICAgIHRhc2tMaXN0W2dldEpvYlF1ZXVlTmFtZSgpXSA9IGNyZWF0ZVRhc2tIYW5kbGVyKHdvcmtmbG93UHJlZml4KTtcblxuICAgIHJ1bm5lciA9IGF3YWl0IHJ1bih7XG4gICAgICBwZ1Bvb2w6IHBvb2wsXG4gICAgICAvLyBEZWZhdWx0IG9mIDUwIGlzIGhpZ2ggZW5vdWdoIHRvIGF2b2lkIHdvcmtlci1wb29sIGV4aGF1c3Rpb24gaW5cbiAgICAgIC8vIHdvcmtmbG93cyB0aGF0IHVzZSBwYXJlbnTihpJjaGlsZCBwb2xsaW5nIHBhdHRlcm5zIChlLmcuIGF3YWl0aW5nIGFcbiAgICAgIC8vIGNoaWxkIHdvcmtmbG93IHZpYSBgY2hpbGRSdW4ucmV0dXJuVmFsdWVgIGluc2lkZSB0aGUgcGFyZW50KS5cbiAgICAgIC8vIEV2ZXJ5IHN1Y2ggcG9sbCBob2xkcyBhIHdvcmtlciBzbG90IGZvciB0aGUgZHVyYXRpb24gb2YgdGhlIGNoaWxkXG4gICAgICAvLyBydW4uIFJlY3Vyc2l2ZSB3b3JrZmxvd3MgbGlrZSBgZmlib25hY2NpV29ya2Zsb3dgIGZhbiBvdXQgcXVpY2tseVxuICAgICAgLy8g4oCUIGZpYig2KSBwcm9kdWNlcyB+MjQgY29uY3VycmVudCBwb2xsaW5nIHN0ZXBzIGF0IHBlYWssIGFuZCBhdFxuICAgICAgLy8gY29uY3VycmVuY3k9MTAgKHRoZSBwcmV2aW91cyBkZWZhdWx0KSBpdCB3b3VsZCBkZWFkbG9jayBvbiB0aGVcbiAgICAgIC8vIGRlZmF1bHQgUG9zdGdyZXMgc2V0dXAuIFNlZSBwYWNrYWdlcy9jb3JlL3NyYy9ydW50aW1lL3J1bi50cyBhbmRcbiAgICAgIC8vIGRvY3MvY29udGVudC9kb2NzL2NoYW5nZWxvZy9lYWdlci1wcm9jZXNzaW5nLm1keCBmb3IgY29udGV4dC5cbiAgICAgIGNvbmN1cnJlbmN5OiBjb25maWcucXVldWVDb25jdXJyZW5jeSB8fCA1MCxcbiAgICAgIGxvZ2dlcjogZ3JhcGhpbGVMb2dnZXIsXG4gICAgICAuLi4oY29uZmlnLmFwcGxpY2F0aW9uTWFuYWdlZFNodXRkb3duID09PSB0cnVlICYmIHtcbiAgICAgICAgbm9IYW5kbGVTaWduYWxzOiB0cnVlLFxuICAgICAgfSksXG4gICAgICBwb2xsSW50ZXJ2YWw6IDUwMCwgLy8gNTAwbXMgPSAwLjVzIChncmFwaGlsZS13b3JrZXIgdXNlcyBMSVNURU4vTk9USUZZIHdoZW4gYXZhaWxhYmxlKVxuICAgICAgdGFza0xpc3QsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGNyZWF0ZVF1ZXVlSGFuZGxlcixcbiAgICBnZXREZXBsb3ltZW50SWQsXG4gICAgcXVldWUsXG4gICAgc3RhcnQsXG4gICAgYXN5bmMgY2xvc2UoKSB7XG4gICAgICBjbG9zaW5nID0gdHJ1ZTtcbiAgICAgIGlmIChydW5uZXJTdGFydCkge1xuICAgICAgICBydW5uZXJTdGFydC5jb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgIGF3YWl0IHJ1bm5lclN0YXJ0LnByb21pc2U7XG4gICAgICAgIHJ1bm5lclN0YXJ0ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHN0YXJ0UHJvbWlzZT8uY2F0Y2goKCkgPT4ge30pO1xuICAgICAgY29uc3QgYWN0aXZlUnVubmVyID0gcnVubmVyO1xuICAgICAgaWYgKGFjdGl2ZVJ1bm5lcikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IGFjdGl2ZVJ1bm5lci5zdG9wKCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgIShlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB8fFxuICAgICAgICAgICAgZXJyb3IubWVzc2FnZSAhPT0gJ1J1bm5lciBpcyBhbHJlYWR5IHN0b3BwZWQnXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgYWN0aXZlUnVubmVyLnByb21pc2UuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICBydW5uZXIgPSBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKHdvcmtlclV0aWxzKSB7XG4gICAgICAgIGF3YWl0IHdvcmtlclV0aWxzLnJlbGVhc2UoKTtcbiAgICAgICAgd29ya2VyVXRpbHMgPSBudWxsO1xuICAgICAgfVxuICAgICAgc3RhcnRQcm9taXNlID0gbnVsbDtcbiAgICAgIGF3YWl0IGxvY2FsV29ybGQuY2xvc2U/LigpO1xuICAgIH0sXG4gIH07XG59XG4iXX0=
