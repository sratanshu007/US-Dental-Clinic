import { DateTime } from "luxon";
import type { BusinessHours } from "../db/schema";

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export const dayKey = (dt: DateTime): DayKey => DAY_KEYS[dt.weekday - 1];

export function parseHHMM(s: string): { hour: number; minute: number } {
  const [h, m] = s.split(":").map(Number);
  return { hour: h, minute: m };
}

/** Opening windows for a given local date, as luxon DateTimes in the clinic zone. */
export function openWindows(hours: BusinessHours, dateISO: string, tz: string): [DateTime, DateTime][] {
  const day = DateTime.fromISO(dateISO, { zone: tz }).startOf("day");
  const windows = hours[dayKey(day)] ?? [];
  return windows.map(([a, b]) => [day.set(parseHHMM(a)), day.set(parseHHMM(b))]);
}

export function isWithinLocalWindow(now: DateTime, start: string, end: string): boolean {
  const s = now.set({ ...parseHHMM(start), second: 0, millisecond: 0 });
  const e = now.set({ ...parseHHMM(end), second: 0, millisecond: 0 });
  return now >= s && now < e;
}

/** Next moment (>= from) that falls inside the clinic's outbound calling window. */
export function nextCallingTime(from: DateTime, start: string, end: string): DateTime {
  if (isWithinLocalWindow(from, start, end)) return from;
  const todayStart = from.set({ ...parseHHMM(start), second: 0, millisecond: 0 });
  return from < todayStart ? todayStart : todayStart.plus({ days: 1 });
}

/** "Tuesday, March 3 at 2:30 PM" — what the AI and SMS say to patients. */
export function speakable(dt: Date, tz: string): string {
  return DateTime.fromJSDate(dt, { zone: tz }).toFormat("cccc, LLLL d 'at' h:mm a");
}

export function localDate(dt: Date, tz: string): string {
  return DateTime.fromJSDate(dt, { zone: tz }).toISODate()!;
}
