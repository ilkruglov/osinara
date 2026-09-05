/**
 * Eve event handling behind the improvement backlog.
 *
 * Export:
 * - `createImprovementSignalHandlers`: collects turn evidence, decides on the trigger, runs the
 *   reflection and records the resulting items for the family.
 *
 * Silent memory review, scheduled runs and subagents never reflect; an external group does,
 * because most tool failures happen there, but its evidence carries no message text either.
 */
import type { SessionAuth } from "eve/context";

import { isMemoryReviewSession } from "../memory-review/memory-review-session.js";
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import type { ImprovementItemInput } from "./improvement-backlog-repository.js";
import { createReflectionRateLimiter, type ReflectionGenerate, reflectOnTurn } from "./reflection.js";
import { createTurnEvidenceCollector, shouldReflectOnTurn, type TurnEvidence } from "./turn-evidence.js";

interface SignalContext {
  channel: { kind?: string };
  session: { auth: SessionAuth; id: string };
}

interface ImprovementSignalDependencies {
  generate?: ReflectionGenerate;
  record(input: ImprovementItemInput): Promise<{ recurred: boolean }>;
}

function reflectionIdentity(ctx: SignalContext): { chatKind: "external" | "family" | "private"; familyId: string } | null {
  if (ctx.channel.kind === "subagent" || isMemoryReviewSession(ctx) || isScheduledSession(ctx)) return null;
  const attributes = ctx.session.auth.current?.attributes;
  if (ctx.session.auth.current?.authenticator !== "telegram" || !attributes) return null;
  const familyId = attributes.familyId;
  if (typeof familyId !== "string") return null;
  const chatKind = attributes.telegramChatType === "private"
    ? "private"
    : attributes.groupType === "family_private" ? "family" : "external";
  return { chatKind, familyId };
}

export function createImprovementSignalHandlers(dependencies: ImprovementSignalDependencies) {
  const collector = createTurnEvidenceCollector();
  const limiter = createReflectionRateLimiter();

  async function finish(ctx: SignalContext, turnId: string, evidence: TurnEvidence | null): Promise<void> {
    if (!evidence || !shouldReflectOnTurn(evidence)) return;
    const identity = reflectionIdentity(ctx);
    if (!identity) return;
    if (!limiter.admit(identity.familyId)) {
      console.info(JSON.stringify({ code: "AGENT_IMPROVEMENT_SKIPPED", reason: "rate_limit", familyId: identity.familyId }));
      return;
    }
    const items = await reflectOnTurn({ chatKind: identity.chatKind, evidence }, dependencies.generate);
    console.info(JSON.stringify({
      code: "AGENT_IMPROVEMENT_REFLECTED",
      chatKind: identity.chatKind,
      failedTools: evidence.failedTools.length,
      items: items.length,
      stepCount: evidence.stepCount,
      turnFailed: evidence.turnFailure !== null,
    }));
    for (const item of items) {
      const result = await dependencies.record({
        category: item.category,
        evidence: {
          errorCode: item.errorCode,
          eveSessionId: ctx.session.id,
          eveTurnId: turnId,
          failedTools: evidence.failedTools,
          stepCount: evidence.stepCount,
          toolName: item.toolName,
          toolNames: evidence.toolNames,
          turnFailure: evidence.turnFailure,
        },
        familyId: identity.familyId,
        fingerprint: item.fingerprint,
        priority: item.priority,
        summary: item.summary,
      });
      console.info(JSON.stringify({
        code: "AGENT_IMPROVEMENT_RECORDED",
        category: item.category,
        fingerprint: item.fingerprint,
        recurred: result.recurred,
      }));
    }
  }

  return {
    actionsRequested(event: { data: { actions: readonly { callId?: string; kind: string; toolName?: string }[]; turnId: string } }, ctx: SignalContext): void {
      collector.actionsRequested({ actions: event.data.actions, sessionId: ctx.session.id, turnId: event.data.turnId });
    },
    actionResult(event: { data: { error?: { code: string; message: string }; result: { callId?: string; kind: string; toolName?: string }; status: "completed" | "failed" | "rejected"; turnId: string } }, ctx: SignalContext): void {
      collector.actionResult({
        callId: event.data.result.callId,
        error: event.data.error,
        sessionId: ctx.session.id,
        status: event.data.status,
        toolName: event.data.result.kind === "tool-result" ? event.data.result.toolName : undefined,
        turnId: event.data.turnId,
      });
    },
    async turnCompleted(event: { data: { turnId: string } }, ctx: SignalContext): Promise<void> {
      await finish(ctx, event.data.turnId, collector.take(ctx.session.id, event.data.turnId));
    },
    async turnFailed(event: { data: { code: string; message: string; turnId: string } }, ctx: SignalContext): Promise<void> {
      collector.turnFailed({ code: event.data.code, message: event.data.message, sessionId: ctx.session.id, turnId: event.data.turnId });
      await finish(ctx, event.data.turnId, collector.take(ctx.session.id, event.data.turnId));
    },
  };
}
