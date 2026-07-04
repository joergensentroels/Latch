// Recurring-task cadence logic for Compass / Latch.
//
// A "schedule" is a stored recurring instruction. On a timer the host materializes a normal task
// from it, which then flows through the usual detect -> approve -> execute pipeline. This module owns
// only the (pure, testable) cadence math: what a cadence means and when it next runs. The record
// shape, task creation, and persistence live in server.js.

export const scheduleCadenceTypes = ["interval", "daily", "weekly"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

// Normalize "H:MM"/"HH:MM" to a valid "HH:MM"; default 09:00.
export function normalizeTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return "09:00";
  const h = clampInt(match[1], 0, 23, 9);
  const m = clampInt(match[2], 0, 59, 0);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function normalizeCadence(raw = {}) {
  const type = scheduleCadenceTypes.includes(raw.type) ? raw.type : "daily";
  return {
    type,
    everyMinutes: clampInt(raw.everyMinutes, 5, 20160, 60), // 5 minutes .. 14 days
    atTime: normalizeTime(raw.atTime),
    dayOfWeek: clampInt(raw.dayOfWeek, 0, 6, 1) // default Monday
  };
}

export function describeCadence(rawCadence) {
  const cadence = normalizeCadence(rawCadence);
  if (cadence.type === "interval") {
    const m = cadence.everyMinutes;
    if (m % 1440 === 0) return `Every ${m / 1440} day(s)`;
    if (m % 60 === 0) return `Every ${m / 60} hour(s)`;
    return `Every ${m} minutes`;
  }
  if (cadence.type === "daily") return `Daily at ${cadence.atTime}`;
  return `Weekly on ${DAY_NAMES[cadence.dayOfWeek]} at ${cadence.atTime}`;
}

// The next run STRICTLY after fromMs. Computed from `from`, not from the last run, so a host that
// was down does not fire a burst of catch-up runs -- it just resumes at the next slot.
export function computeNextRun(rawCadence, fromMs) {
  const cadence = normalizeCadence(rawCadence);
  const from = Number.isFinite(fromMs) ? fromMs : Date.now();

  if (cadence.type === "interval") {
    return new Date(from + cadence.everyMinutes * 60_000).toISOString();
  }

  const [hours, minutes] = cadence.atTime.split(":").map((part) => Number.parseInt(part, 10));
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);

  if (cadence.type === "daily") {
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  // weekly
  const dayDiff = (cadence.dayOfWeek - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + dayDiff);
  if (next.getTime() <= from) next.setDate(next.getDate() + 7);
  return next.toISOString();
}

// Enabled schedules whose next run is due at/​before nowMs.
export function dueSchedules(schedules, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return (Array.isArray(schedules) ? schedules : []).filter(
    (schedule) => schedule && schedule.enabled && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= now
  );
}
