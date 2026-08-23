#!/usr/bin/env node
const { extractTimelines } = require("../analysis/phase2.js");

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}
const base = {
  queueName: "QA Queue Alpha",
  memberNames: ["Fred Luddy", "ITIL User"],
  stateMap: { 1: "New", 2: "In Progress", 3: "On Hold", 6: "Resolved", 7: "Closed" },
  snapshotGroupName: "QA Queue Alpha"
};
const ev = (field, oldValue, newValue, at) => ({ field, oldValue, newValue, at });

console.log("== assignTime clamp to opened_at ==");
check("backdated group entry clamps to opened_at",
  extractTimelines([
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-03-11 10:00:00"),
    ev("assigned_to", "", "Fred Luddy", "2026-03-12 09:00:00")
  ], { ...base, openedAt: "2026-03-13 08:00:00" }).assignTime,
  "2026-03-13T08:00:00.000Z");
check("normal entry after birth untouched",
  extractTimelines([
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-03-14 10:00:00")
  ], { ...base, openedAt: "2026-03-13 08:00:00" }).assignTime,
  "2026-03-14T10:00:00.000Z");
check("no openedAt in ctx -> no clamp applied",
  extractTimelines([
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2020-01-01 00:00:00")
  ], base).assignTime,
  "2020-01-01T00:00:00.000Z");
check("born-in-queue fallback still equals opened_at",
  extractTimelines([], { ...base, openedAt: "2026-03-13 08:00:00" }).assignTime,
  "2026-03-13T08:00:00.000Z");
check("ackn eligibility unaffected by clamp (pre-birth assignment still counts)",
  (() => {
    const t = extractTimelines([
      ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-03-11 10:00:00"),
      ev("assigned_to", "", "Fred Luddy", "2026-03-12 09:00:00")
    ], { ...base, openedAt: "2026-03-13 08:00:00" });
    return [t.assignTime, t.acknTime];
  })(),
  ["2026-03-13T08:00:00.000Z", "2026-03-12T09:00:00.000Z"]);

console.log("== classic regressions ==");
check("prequeue ackn ignored",
  extractTimelines([
    ev("assigned_to", "", "Fred Luddy", "2026-08-23 06:06:40"),
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-08-23 06:06:43")
  ], { ...base, openedAt: "2026-08-23 06:06:35" }).acknTime,
  null);
check("group re-entry takes latest entry",
  extractTimelines([
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-08-23 06:06:50"),
    ev("assignment_group", "QA Queue Alpha", "Other Queue", "2026-08-23 06:06:55"),
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-08-23 06:07:03"),
    ev("assigned_to", "", "ITIL User", "2026-08-23 06:07:06")
  ], { ...base, openedAt: "2026-08-23 06:06:45" }).assignTime,
  "2026-08-23T06:07:03.000Z");
check("first On Hold wins, double hold counted",
  (() => {
    const t = extractTimelines([
      ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-08-23 06:08:00"),
      ev("state", "2", "3", "2026-08-23 06:08:10"),
      ev("state", "3", "2", "2026-08-23 06:08:20"),
      ev("state", "2", "3", "2026-08-23 06:08:30"),
      ev("state", "3", "2", "2026-08-23 06:08:40")
    ], { ...base, openedAt: "2026-08-23 06:08:00" });
    return [t.suspendTime, t.onHoldCount];
  })(),
  ["2026-08-23T06:08:10.000Z", 2]);
check("hold->resolve gives resumeSource Resolved",
  (() => {
    const t = extractTimelines([
      ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-08-23 06:09:00"),
      ev("state", "2", "3", "2026-08-23 06:09:05"),
      ev("state", "3", "6", "2026-08-23 06:09:10")
    ], { ...base, openedAt: "2026-08-23 06:09:00" });
    return [t.resumeTime, t.resumeSource];
  })(),
  ["2026-08-23T06:09:10.000Z", "Resolved"]);
check("suspend only while in queue (hold during OTHER ignored)",
  extractTimelines([
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-08-23 06:07:30"),
    ev("assignment_group", "QA Queue Alpha", "Other Queue", "2026-08-23 06:07:32"),
    ev("state", "2", "3", "2026-08-23 06:07:33"),
    ev("state", "3", "2", "2026-08-23 06:07:34"),
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-08-23 06:07:35")
  ], { ...base, openedAt: "2026-08-23 06:07:20" }).suspendTime,
  null);
check("never held -> resume stays null",
  extractTimelines([
    ev("assignment_group", "Other Queue", "QA Queue Alpha", "2026-08-23 06:06:20"),
    ev("state", "1", "6", "2026-08-23 06:06:25")
  ], { ...base, openedAt: "2026-08-23 06:06:20" }).resumeTime,
  null);

console.log(`\nphase2: ${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
