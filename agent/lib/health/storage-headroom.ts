/**
 * Free disk space against what an update needs.
 *
 * Exports:
 * - `StorageHeadroom`: free and total bytes of the filesystem and the size of both databases.
 * - `readStorageHeadroom`: a snapshot for now.
 * - `formatStorageHeadroom`: the digest line, or null on a quiet day.
 *
 * Key constructs:
 * - Two updates in a row (1.2.2 and 1.3.0, 25 сентября 2026) failed on disk space, found by a
 *   person after the fact. The installer's preflight asks for (durable volumes + both databases)
 *   × 2 + 512 MiB; the digest applies the same formula to the databases it can measure, so the
 *   owner reads the shortfall before pressing the update button.
 * - The filesystem is read from inside the container: the Docker volumes live on the same one
 *   as its root, and `statfs` tells the truth about it.
 * - Neither reading blocks the other, and neither failure blocks the digest.
 * - Ported from artkruglov/homka (Apache-2.0) on 26 сентября 2026, formula adapted.
 */
import { statfs } from "node:fs/promises";

export const STORAGE_HEADROOM_WARNING_FRACTION = 0.2;
const UPDATE_RESERVE_BYTES = 512 * 1024 * 1024;

export interface StorageHeadroom {
  readonly databaseBytes: number | null;
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1).replace(".", ",")} ГиБ`;
}

/** What the installer's preflight will ask for, from the part of the formula the digest can measure. */
export function updateRequirementBytes(databaseBytes: number): number {
  return databaseBytes * 2 + UPDATE_RESERVE_BYTES;
}

/** Printed when free space is scarce or an update would not pass the installer's space check. */
export function formatStorageHeadroom(headroom: StorageHeadroom): string | null {
  const { databaseBytes, freeBytes, totalBytes } = headroom;
  if (freeBytes === null || totalBytes === null || totalBytes === 0) return null;
  const fraction = freeBytes / totalBytes;
  const tight = fraction < STORAGE_HEADROOM_WARNING_FRACTION;
  const updateDoesNotFit = databaseBytes !== null && updateRequirementBytes(databaseBytes) > freeBytes;
  if (!tight && !updateDoesNotFit) return null;
  const percent = Math.round(fraction * 100);
  const database = databaseBytes === null ? "" : `, базы ${gigabytes(databaseBytes)}`;
  return [
    `Диск: свободно ${gigabytes(freeBytes)} из ${gigabytes(totalBytes)} (${percent} %)${database}.`,
    updateDoesNotFit && databaseBytes !== null
      ? `Обновление не пройдёт проверку места: нужно не меньше ${gigabytes(updateRequirementBytes(databaseBytes))}, освободите заранее.`
      : "Места мало: обновлению нужен бэкап обеих баз и образы.",
  ].join(" ");
}

export async function readStorageHeadroom(
  databaseSize: () => Promise<number | null>,
  path = "/",
): Promise<StorageHeadroom> {
  const [space, databaseBytes] = await Promise.all([
    statfs(path).then(
      (stats) => ({ freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) }),
      (error: unknown) => {
        console.error(JSON.stringify({ code: "AGENT_STORAGE_HEADROOM_UNREADABLE", error: error instanceof Error ? error.message : String(error) }));
        return { freeBytes: null, totalBytes: null };
      },
    ),
    databaseSize().catch((error: unknown) => {
      console.error(JSON.stringify({ code: "AGENT_DATABASE_SIZE_UNREADABLE", error: error instanceof Error ? error.message : String(error) }));
      return null;
    }),
  ]);
  return { databaseBytes, ...space };
}
