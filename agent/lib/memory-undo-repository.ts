/**
 * Durable immediate-undo boundary for long-term memory creates.
 *
 * Exports:
 * - `MemoryUndoInput`: verified Eve call/session/turn identity for one undo attempt.
 * - `MEMORY_UNDO_DENIED_MESSAGE`: stable user-facing denial with a safe next step.
 *
 * Key construct:
 * - The undo itself lives in `memoryRepository.undoCreate`: only an unchanged create from the same
 *   verified user, session and turn qualifies.
 */
import type { MemoryOperationProvenance } from "./memory-record.js";

export const MEMORY_UNDO_DENIED_MESSAGE =
  "Без подтверждения можно отменить только неизменённую запись, созданную вами в текущем действии. Для другой записи запросите отдельное удаление";

export interface MemoryUndoInput extends MemoryOperationProvenance {
  operationKey: string;
}
