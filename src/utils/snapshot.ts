import type { Snapshot } from "../types";

export const SNAPSHOTS: readonly Snapshot[] = ["start", "end"];

export const SNAPSHOT_LABEL: Record<Snapshot, string> = {
  start: "Start of day",
  end: "End of day",
};

export const SNAPSHOT_UTC_TIME: Record<Snapshot, string> = {
  start: "00:00:00 UTC",
  end: "23:59:59 UTC",
};

// Seconds from 00:00:00 UTC to the snapshot instant. "end" is the last whole
// second of the day, so EVM resolves the last block with timestamp <= 23:59:59
// and Bitcoin the last block at or before it.
const SNAPSHOT_OFFSET_SECONDS: Record<Snapshot, number> = {
  start: 0,
  end: 86399,
};

export const END_OF_DAY_NOT_REACHED_MESSAGE =
  "End of day has not been reached yet for this date — choose Start of day or an earlier date.";

export const isSnapshot = (value: string): value is Snapshot =>
  (SNAPSHOTS as readonly string[]).includes(value);

// "End of day (23:59:59 UTC)" — used in the PDF so the record states exactly
// which instant the balance refers to.
export function snapshotDescription(snapshot: Snapshot): string {
  return `${SNAPSHOT_LABEL[snapshot]} (${SNAPSHOT_UTC_TIME[snapshot]})`;
}

// True for a YYYY-MM-DD string that parses as a UTC calendar day. Lets the UI
// skip the end-of-day check while the date field itself is invalid (DateInput
// reports that case on its own) instead of throwing during render.
export function isParsableDay(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(new Date(date + "T00:00:00Z").getTime());
}

// Unix timestamp (seconds) of the snapshot instant for a YYYY-MM-DD calendar
// day read as UTC. Throws on an unparseable date instead of returning a
// placeholder.
export function snapshotTimestamp(date: string, snapshot: Snapshot): number {
  const startOfDay = new Date(date + "T00:00:00Z");
  if (isNaN(startOfDay.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  return Math.floor(startOfDay.getTime() / 1000) + SNAPSHOT_OFFSET_SECONDS[snapshot];
}

// True when the snapshot instant still lies in the future, i.e. the chain
// cannot yet hold the requested balance. Only "end" can trigger this for a
// date that already passed the date validation (no future dates).
export function snapshotNotReached(date: string, snapshot: Snapshot, nowMs: number): boolean {
  return snapshotTimestamp(date, snapshot) * 1000 > nowMs;
}
