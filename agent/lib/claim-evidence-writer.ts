/**
 * Validated claim-evidence contracts for the single memory writer transaction.
 *
 * Exports:
 * - `PreparedClaimEvidence`: trusted claim fields and normalized source rows derived from PostgreSQL.
 * - `insertClaimEvidence` and `insertClaimReinforcement`: re-export transaction persistence helpers.
 */
export { insertClaimEvidence, insertClaimReinforcement } from "./claim-evidence-persistence.js";

export interface PreparedEvidenceSource {
  authorLabelSnapshot: string | null;
  authorParticipantId: string;
  authorUserId: string | null;
  authorTelegramUserId: string;
  evidenceSnippet: string;
  messageThreadId: string | null;
  observedAt: Date;
  role: "primary" | "supporting";
  sourceMessageId: string;
  sourceSnapshot: Record<string, string | null>;
  timelineEntryId: string | null;
  timelineSequence: string;
}

export interface PreparedClaimEvidence {
  auditActorUserId: string | null;
  contentNormalized: string;
  conversationId: string;
  conversationLabelSnapshot: string;
  evidenceKind: "firsthand" | "inferred" | "reported";
  familyId: string;
  primaryAuthorTelegramUserId: string;
  primaryAuthorUserId: string | null;
  /**
   * Who took the evidence down: Mia in the turn of the message's author (`turn`), or someone
   * reading the chat afterwards (`review`: the silent review, or another person's turn); a person
   * card ranks the first above the second (owner, 23 November 2026).
   */
  recordedBy: "review" | "turn";
  scope: "family" | "group" | "personal";
  scopePartitionKey: string;
  sources: PreparedEvidenceSource[];
  subjectConversationId: string | null;
  subjectKind: "current_author" | "label" | "none" | "verified_ref";
  subjectLabel: string | null;
  subjectParticipantId: string | null;
  subjectUserId: string | null;
  telegramGroupId: string | null;
}
