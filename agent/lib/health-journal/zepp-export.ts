/**
 * Parses a Zepp (Amazfit) data export into journal rows.
 *
 * Exports:
 * - `parseZeppExport`: daily activity, nights of sleep and weigh-ins from the export zip.
 * - `ZeppExportError`: a named reason the archive could not be read.
 * - `lastByKey`: one row per key, the later one winning.
 * - `ZeppExport`, `ZeppActivityDay`, `ZeppSleepNight`, `ZeppWeighIn`: the parsed rows.
 *
 * Key constructs (format checked against a real export on 11 November 2026):
 * - The export is a zip, AES-encrypted with a password the Zepp app shows, holding folders of CSV
 *   files: `ACTIVITY/ACTIVITY_<n>.csv` (`date,steps,distance,runDistance,calories`, one civil day
 *   per row), `SLEEP/SLEEP_<n>.csv` (`date,deepSleepTime,shallowSleepTime,wakeTime,start,stop,
 *   REMTime,naps`: minutes, the day of waking, UTC start and stop) and `BODY/BODY_<n>.csv`
 *   (`time,weight,height,bmi,fatRate,…`, UTC time). Other folders are ignored.
 * - A night's total is deep + light + REM (their sum matched start-to-stop on the real export);
 *   `wakeTime` is the minutes awake inside it. Days and nights of zeros are a band not worn and
 *   are skipped, as are values outside the journal's own ranges; a required value that does not
 *   parse (a date, steps, minutes, a time, a weight) refuses the whole archive. On the real export
 *   of 11 November 2026 every such value parsed; only the fat rate was «null» or «0.0».
 * - A date repeated across or within files is one row (the later one): one INSERT … ON CONFLICT
 *   cannot touch a row twice.
 * - The `naps` column holds quoted JSON with backslash escapes, which is not standard CSV; only the
 *   leading columns are read, so it never needs parsing.
 */
import { isRealDate } from "./health-formulas.js";
import { readZipEntries, ZipArchiveError } from "./zip-archive.js";

export interface ZeppActivityDay {
  date: string;
  distanceM: number;
  steps: number;
}

export interface ZeppSleepNight {
  awakeMin: number;
  deepMin: number;
  end: string;
  lightMin: number;
  remMin: number;
  start: string;
  totalMin: number;
  wakeDate: string;
}

export interface ZeppWeighIn {
  bodyFatPct: number | null;
  measuredAt: string;
  weightKg: number;
}

export interface ZeppExport {
  activity: ZeppActivityDay[];
  sleep: ZeppSleepNight[];
  weighIns: ZeppWeighIn[];
}

export class ZeppExportError extends Error {
  constructor(
    readonly reason:
      "corrupt" | "no_data" | "password_required" | "password_wrong" | "too_large" | "unsupported",
  ) {
    super(`zepp export: ${reason}`);
    this.name = "ZeppExportError";
  }
}

const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
/** A real export holds one file per folder; a few more leave room for a split export. */
const MAX_ENTRIES = 12;
const ENTRY_PATTERN = /(?:^|\/)(ACTIVITY|SLEEP|BODY)\/\1_\d+\.csv$/u;
const UTC_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\+0000$/u;

const HEADERS = {
  ACTIVITY: ["date", "steps", "distance"],
  BODY: ["time", "weight", "height", "bmi", "fatRate"],
  SLEEP: ["date", "deepSleepTime", "shallowSleepTime", "wakeTime", "start", "stop", "REMTime"],
} as const;

function rows(bytes: Buffer, kind: keyof typeof HEADERS): string[][] {
  const lines = bytes.toString("utf8").replace(/^﻿/u, "").split(/\r?\n/u);
  const header = HEADERS[kind];
  const first = lines[0]?.split(",", header.length) ?? [];
  if (header.some((name, index) => first[index] !== name)) throw new ZeppExportError("unsupported");
  return lines
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => line.split(",", header.length));
}

function integer(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  return Number(value);
}

function decimal(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(\.\d+)?$/u.test(value)) return null;
  return Number(value);
}

function utcInstant(value: string | undefined): string | null {
  const match = value === undefined ? null : UTC_TIME.exec(value);
  return match ? `${match[1]}T${match[2]}Z` : null;
}

/** A required value that does not parse means a damaged file: nothing of it is imported. */
function required<T>(value: T | null): T {
  if (value === null) throw new ZeppExportError("corrupt");
  return value;
}

function requiredDate(value: string | undefined): string {
  return required(value !== undefined && isRealDate(value) ? value : null);
}

/** Files in the order of their number: ACTIVITY_10 comes after ACTIVITY_2. */
function fileOrder([a]: [string, Buffer], [b]: [string, Buffer]): number {
  const number = (name: string) => Number(/_(\d+)\.csv$/u.exec(name)?.[1] ?? 0);
  return a.split("/").at(-2)!.localeCompare(b.split("/").at(-2)!) || number(a) - number(b);
}

function parseActivity(bytes: Buffer): ZeppActivityDay[] {
  const days: ZeppActivityDay[] = [];
  for (const [date, steps, distance] of rows(bytes, "ACTIVITY")) {
    const day = requiredDate(date);
    const stepCount = required(integer(steps));
    const meters = required(integer(distance));
    if (stepCount === 0 && meters === 0) continue;
    if (stepCount > 150_000 || meters > 300_000) continue;
    days.push({ date: day, distanceM: meters, steps: stepCount });
  }
  return days;
}

function parseSleep(bytes: Buffer): ZeppSleepNight[] {
  const nights: ZeppSleepNight[] = [];
  for (const [date, deep, light, awake, start, stop, rem] of rows(bytes, "SLEEP")) {
    const wakeDate = requiredDate(date);
    const deepMin = required(integer(deep));
    const lightMin = required(integer(light));
    const awakeMin = required(integer(awake));
    const remMin = required(integer(rem));
    const startAt = required(utcInstant(start));
    const endAt = required(utcInstant(stop));
    const totalMin = deepMin + lightMin + remMin;
    if (totalMin === 0 || totalMin > 1440 || endAt <= startAt) continue;
    nights.push({
      awakeMin: Math.min(awakeMin, 1440),
      deepMin,
      end: endAt,
      lightMin,
      remMin,
      start: startAt,
      totalMin,
      wakeDate,
    });
  }
  return nights;
}

function parseBody(bytes: Buffer): ZeppWeighIn[] {
  const weighIns: ZeppWeighIn[] = [];
  for (const [time, weight, , , fatRate] of rows(bytes, "BODY")) {
    const measuredAt = required(utcInstant(time));
    const weightKg = required(decimal(weight));
    // The real export writes «null» or «0.0» when the scales measured no fat.
    const fat = decimal(fatRate);
    if (weightKg < 20 || weightKg > 400) continue;
    weighIns.push({
      bodyFatPct: fat !== null && fat >= 2 && fat <= 75 ? fat : null,
      measuredAt,
      weightKg,
    });
  }
  return weighIns;
}

/** One row per key, the later one winning: files are read in number order, rows in file order. */
export function lastByKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map((row) => [key(row), row])).values()].sort((a, b) =>
    key(a).localeCompare(key(b)),
  );
}

export function parseZeppExport(zip: Buffer, password: string | null): ZeppExport {
  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(zip, (name) => ENTRY_PATTERN.test(name), {
      maxEntries: MAX_ENTRIES,
      maxEntryBytes: MAX_ENTRY_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      password,
    });
  } catch (error) {
    if (error instanceof ZipArchiveError)
      throw new ZeppExportError(
        error.reason === "encrypted_unsupported" ? "unsupported" : error.reason,
      );
    throw error;
  }
  const result: ZeppExport = { activity: [], sleep: [], weighIns: [] };
  for (const [name, bytes] of [...entries].sort(fileOrder)) {
    const kind = ENTRY_PATTERN.exec(name)![1] as keyof typeof HEADERS;
    if (kind === "ACTIVITY") result.activity.push(...parseActivity(bytes));
    if (kind === "SLEEP") result.sleep.push(...parseSleep(bytes));
    if (kind === "BODY") result.weighIns.push(...parseBody(bytes));
  }
  if (entries.size === 0) throw new ZeppExportError("no_data");
  return {
    activity: lastByKey(result.activity, (day) => day.date),
    sleep: lastByKey(result.sleep, (night) => night.wakeDate),
    weighIns: lastByKey(result.weighIns, (entry) => entry.measuredAt),
  };
}
