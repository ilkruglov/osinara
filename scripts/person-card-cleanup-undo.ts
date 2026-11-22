/**
 * Undo of the person card cleanup, run by hand in the agent container.
 *
 * Usage (production image, where only the bundle exists):
 *   node .runtime/scripts/person-card-cleanup-undo.js --all
 *   node .runtime/scripts/person-card-cleanup-undo.js --build <build id>
 *
 * Returns to active every record the cards marked as a repeat or as refuted, except the ones people
 * changed or deleted since, and prints the counts as one JSON line. Production data changes only on
 * the owner's word.
 */
import { isAppError } from "../agent/lib/app-error.js";
import { closeDatabase } from "../agent/lib/database.js";
import { undoPersonCardCleanups } from "../agent/lib/person-cards/person-card-cleanup-undo.js";
import { UUID_PATTERN } from "../agent/lib/tool-input-validation.js";

function buildIdFrom(argv: readonly string[]): string | null {
  if (argv.length === 1 && argv[0] === "--all") return null;
  if (argv.length === 2 && argv[0] === "--build" && UUID_PATTERN.test(argv[1] ?? ""))
    return argv[1]!;
  console.error("Usage: person-card-cleanup-undo (--all | --build <build id>)");
  process.exit(2);
}

try {
  const result = await undoPersonCardCleanups({ buildId: buildIdFrom(process.argv.slice(2)) });
  console.info(JSON.stringify({ code: "AGENT_PERSON_CARD_CLEANUP_UNDONE", ...result }));
} catch (error) {
  console.error(
    JSON.stringify({
      code: isAppError(error) ? error.code : "AGENT_PERSON_CARD_CLEANUP_UNDO_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
