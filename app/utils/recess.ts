import { fromDate, toZoned } from "@internationalized/date";
import { APP_TIME_ZONE } from "~/utils/format";

/**
 * When a recess resumes, from the "HH:MM" the Mesa types, as an ISO
 * instant: that time today in Europe/Madrid, or tomorrow when it has
 * already passed (a recess called at 23:50 until 00:15). Null for an empty
 * or malformed time.
 */
export function recessUntilFromTime(
  value: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  let target = fromDate(now, APP_TIME_ZONE).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  if (target.toDate().getTime() <= now.getTime()) {
    target = toZoned(target.add({ days: 1 }), APP_TIME_ZONE);
  }
  return target.toAbsoluteString();
}

/** "HH:MM" of an instant in Europe/Madrid, for the time field. */
export function recessTimeOf(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const zoned = fromDate(date, APP_TIME_ZONE);
  return `${String(zoned.hour).padStart(2, "0")}:${String(zoned.minute).padStart(2, "0")}`;
}
