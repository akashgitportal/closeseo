export type ScheduleInterval = "manual" | "daily" | "weekly" | "monthly";
export type ScheduleTime = { weekday?: number; hour: number; minute: number; timeZone?: string };
export type ScheduledInterval = Exclude<ScheduleInterval, "manual">;

export const CHECKS_PER_MONTH: Record<ScheduledInterval, number> = { daily: 30, weekly: 4, monthly: 1 };
const DAY_MS = 86_400_000;

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** The chosen wall-clock time re-expressed in UTC using the zone's offset right now; reports how many days that moved. */
function toUtcTime(t: ScheduleTime, now: number) {
  if (!t.timeZone) return { weekday: t.weekday, hour: t.hour, minute: t.minute, dayShift: 0 };
  const f = new Intl.DateTimeFormat("en-US", { timeZone: t.timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(now)) if (x.type !== "literal") p[x.type] = Number(x.value);
  const wallAsUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
  const offsetMinutes = (wallAsUtc - (now - (now % 60_000))) / 60_000;
  const utcMinutes = t.hour * 60 + t.minute - offsetMinutes;
  const dayShift = Math.floor(utcMinutes / 1440);
  const minutesOfDay = utcMinutes - dayShift * 1440;
  return { weekday: t.weekday === undefined ? undefined : (t.weekday + dayShift + 7) % 7, hour: Math.floor(minutesOfDay / 60), minute: minutesOfDay % 60, dayShift };
}

const monthEnd = (year: number, month: number, dayShift: number, hour: number, minute: number) => new Date(Date.UTC(year, month + 1, dayShift, hour, minute));

/** Read the day shift of a stored monthly anchor back off its date: +1 (the 1st), -1 (day before last), or 0 (last day). */
function monthlyDayShift(anchor: Date): number {
  if (anchor.getUTCDate() === 1) return 1;
  const last = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  return anchor.getUTCDate() === last - 1 ? -1 : 0;
}

/**
 * Next check time for a scheduled tracker. With `previous` it advances from that anchor by the interval until
 * it is in the future (no drift when runs are late). Otherwise the first check lands on the chosen time, or on a
 * random hour (04-09 UTC) and minute that spreads load across scheduler ticks. Monthly checks run on the last day
 * of the month in the user's zone.
 */
export function computeNextCheckAt(
  interval: ScheduledInterval, previous?: string | null, chosen?: ScheduleTime, now = Date.now(), rand: () => number = Math.random,
): string {
  const t = chosen && toUtcTime(chosen, now);
  if (interval === "monthly") {
    if (previous) {
      const a = new Date(previous);
      const shift = monthlyDayShift(a);
      let month = a.getUTCMonth() + (shift === 1 ? 0 : 1);
      let next = monthEnd(a.getUTCFullYear(), month, shift, a.getUTCHours(), a.getUTCMinutes());
      while (next.getTime() <= now) next = monthEnd(a.getUTCFullYear(), ++month, shift, a.getUTCHours(), a.getUTCMinutes());
      return next.toISOString();
    }
    const hour = t?.hour ?? 4 + Math.floor(rand() * 6), minute = t?.minute ?? Math.floor(rand() * 60), shift = t?.dayShift ?? 0;
    const today = new Date(now);
    let month = today.getUTCMonth() - 1;
    let next = monthEnd(today.getUTCFullYear(), month, shift, hour, minute);
    while (next.getTime() <= now) next = monthEnd(today.getUTCFullYear(), ++month, shift, hour, minute);
    return next.toISOString();
  }
  const days = interval === "daily" ? 1 : 7;
  if (previous) {
    const anchor = new Date(previous).getTime();
    const steps = Math.floor(Math.max(0, now - anchor) / (days * DAY_MS)) + 1;
    return new Date(anchor + steps * days * DAY_MS).toISOString();
  }
  if (t) {
    const next = new Date(now);
    next.setUTCHours(t.hour, t.minute, 0, 0);
    const weekday = interval === "weekly" ? t.weekday : undefined;
    if (weekday !== undefined) next.setUTCDate(next.getUTCDate() + ((weekday - next.getUTCDay() + 7) % 7));
    if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + (weekday === undefined ? 1 : 7));
    return next.toISOString();
  }
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + days);
  next.setUTCHours(4 + Math.floor(rand() * 6), Math.floor(rand() * 60), 0, 0);
  return next.toISOString();
}
