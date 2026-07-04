// Unit tests for the recurring-task cadence logic (schedule.mjs).
// Time-of-day tests assert invariants (strictly-forward, correct local HH:MM, within the window)
// rather than exact timestamps, so they pass in any timezone.

import assert from "node:assert/strict";
import { normalizeCadence, describeCadence, computeNextRun, dueSchedules, normalizeTime } from "../schedule.mjs";

// normalizeTime
assert.equal(normalizeTime("9:05"), "09:05");
assert.equal(normalizeTime("25:70"), "23:59", "out-of-range time is clamped");
assert.equal(normalizeTime("nope"), "09:00", "garbage falls back to 09:00");
assert.equal(normalizeTime("9:5"), "09:00", "minutes must be two digits");

// normalizeCadence defaults + clamps
const def = normalizeCadence({});
assert.equal(def.type, "daily");
assert.equal(def.everyMinutes, 60);
assert.equal(def.atTime, "09:00");
assert.equal(def.dayOfWeek, 1);
assert.equal(normalizeCadence({ type: "interval", everyMinutes: 1 }).everyMinutes, 5, "interval floor is 5 min");
assert.equal(normalizeCadence({ everyMinutes: 999999 }).everyMinutes, 20160, "interval ceiling is 14 days");
assert.equal(normalizeCadence({ type: "bogus" }).type, "daily", "unknown type falls back to daily");

// describeCadence
assert.equal(describeCadence({ type: "interval", everyMinutes: 45 }), "Every 45 minutes");
assert.equal(describeCadence({ type: "interval", everyMinutes: 120 }), "Every 2 hour(s)");
assert.equal(describeCadence({ type: "interval", everyMinutes: 2880 }), "Every 2 day(s)");
assert.equal(describeCadence({ type: "daily", atTime: "07:30" }), "Daily at 07:30");
assert.equal(describeCadence({ type: "weekly", dayOfWeek: 1, atTime: "08:00" }), "Weekly on Monday at 08:00");

// interval: exact arithmetic
assert.equal(computeNextRun({ type: "interval", everyMinutes: 30 }, 0), new Date(30 * 60_000).toISOString());

function hhmm(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// daily: strictly forward, correct local time, within 24h
const dailyFrom = Date.parse("2026-07-04T12:00:00");
const dailyNext = computeNextRun({ type: "daily", atTime: "09:00" }, dailyFrom);
assert.ok(Date.parse(dailyNext) > dailyFrom, "daily next run is strictly in the future");
assert.equal(hhmm(new Date(dailyNext)), "09:00", "daily next run lands at the requested local time");
assert.ok(Date.parse(dailyNext) - dailyFrom <= 24 * 3600 * 1000, "daily next run is within 24h");

// daily where the time is still ahead today -> should be today (< 24h, same date semantics)
const dailyAheadNext = computeNextRun({ type: "daily", atTime: "23:59" }, Date.parse("2026-07-04T08:00:00"));
assert.ok(Date.parse(dailyAheadNext) - Date.parse("2026-07-04T08:00:00") < 24 * 3600 * 1000, "a later-today time schedules today");

// weekly: strictly forward, correct weekday + time, within 7 days
const weeklyFrom = Date.parse("2026-07-04T12:00:00");
const weeklyNext = computeNextRun({ type: "weekly", dayOfWeek: 3, atTime: "06:15" }, weeklyFrom);
const weeklyDate = new Date(weeklyNext);
assert.ok(Date.parse(weeklyNext) > weeklyFrom, "weekly next run is strictly in the future");
assert.equal(weeklyDate.getDay(), 3, "weekly next run lands on the requested weekday");
assert.equal(hhmm(weeklyDate), "06:15", "weekly next run lands at the requested time");
assert.ok(Date.parse(weeklyNext) - weeklyFrom <= 7 * 24 * 3600 * 1000, "weekly next run is within 7 days");

// dueSchedules: only enabled schedules whose nextRunAt has passed
const now = Date.parse("2026-07-04T12:00:00");
const due = dueSchedules([
  { id: "a", enabled: true, nextRunAt: new Date(now - 1000).toISOString() },
  { id: "b", enabled: false, nextRunAt: new Date(now - 1000).toISOString() },
  { id: "c", enabled: true, nextRunAt: new Date(now + 60_000).toISOString() },
  { id: "d", enabled: true, nextRunAt: "" }
], now);
assert.deepEqual(due.map((s) => s.id), ["a"], "only enabled + past-due schedules are returned");

console.log("Schedule unit tests passed.");
