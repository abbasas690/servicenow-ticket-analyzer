#!/usr/bin/env node
const { detectSnOffsetMs, rowOffsetMs, fmtWithOffset } = require("../analysis/workbook.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? `  got=${JSON.stringify(extra)}` : ""}`); }
}

console.log("== parse/detect: detectSnOffsetMs ==");

check("positive offset +5:30 (IST)", (() => {
  const off = detectSnOffsetMs([{ openedAt: "2026-08-23 11:36:35", openedAtRaw: "2026-08-23 06:06:35" }]);
  return off === 5.5 * 3600e3;
})(), detectSnOffsetMs([{ openedAt: "2026-08-23 11:36:35", openedAtRaw: "2026-08-23 06:06:35" }]));

check("negative offset -7:00 (PDT)", (() => {
  const off = detectSnOffsetMs([{ openedAt: "2026-08-23 06:06:35", openedAtRaw: "2026-08-23 13:06:35" }]);
  return off === -7 * 3600e3;
})(), detectSnOffsetMs([{ openedAt: "2026-08-23 06:06:35", openedAtRaw: "2026-08-23 13:06:35" }]));

check("zero offset (UTC profile)", (() => {
  const off = detectSnOffsetMs([{ openedAt: "2026-08-23 06:06:35", openedAtRaw: "2026-08-23 06:06:35" }]);
  return off === 0;
})(), "");

check("missing raw -> 0 fallback", detectSnOffsetMs([{ openedAt: "2026-08-23 06:06:35" }]) === 0);
check("empty rows -> 0", detectSnOffsetMs([]) === 0);
check("garbage pair skipped, second row used", (() => {
  const off = detectSnOffsetMs([
    { openedAt: "nonsense", openedAtRaw: "also-bad" },
    { openedAt: "2026-01-02 03:04:05", openedAtRaw: "2026-01-02 00:00:00" }
  ]);
  return off === 3 * 3600e3 + 4 * 60e3 + 5e3;
})(), "");

check("median over many pairs (one outlier ignored)", (() => {
  const rows = [
    { openedAt: "2026-08-23 13:42:00", openedAtRaw: "2026-08-23 20:42:00" },
    { openedAt: "nonsense", openedAtRaw: "x" },
    { openedAt: "2026-08-23 13:00:00", openedAtRaw: "2026-08-23 20:00:00" },
    { openedAt: "2026-08-22 06:06:35", openedAtRaw: "2026-08-22 13:06:35" },
    { openedAt: "2026-08-21 01:00:00", openedAtRaw: "2026-08-21 20:00:00" }
  ];
  return detectSnOffsetMs(rows) === -7 * 3600e3;
})(), detectSnOffsetMs([
  { openedAt: "2026-08-23 13:42:00", openedAtRaw: "2026-08-23 20:42:00" },
  { openedAt: "2026-08-23 13:00:00", openedAtRaw: "2026-08-23 20:00:00" },
  { openedAt: "2026-08-22 06:06:35", openedAtRaw: "2026-08-22 13:06:35" },
  { openedAt: "2026-08-21 01:00:00", openedAtRaw: "2026-08-21 20:00:00" }
]));

console.log("== per-row offset (DST fix) ==");
const summer = { openedAt: "2026-07-29 04:49:28", openedAtRaw: "2026-07-29 11:49:28" };
const winter = { openedAt: "2021-01-15 05:04:14", openedAtRaw: "2026-01-15 13:04:14".replace("2026", "2021") };
check("summer row -> -7h even with winter global fallback", rowOffsetMs(summer, -8 * 3600e3) === -7 * 3600e3);
check("winter row -> -8h even with summer global fallback", rowOffsetMs(winter, -7 * 3600e3) === -8 * 3600e3, rowOffsetMs(winter, -7 * 3600e3));
check("row without pair falls back to global", rowOffsetMs({ openedAt: "" }, -7 * 3600e3) === -7 * 3600e3);

console.log("== format: fmtWithOffset ==");

const T0 = "2026-08-22T13:42:14Z";
check("shift -7h stays same day", fmtWithOffset(T0, -7 * 3600e3) === "2026-08-22 06:42:14", fmtWithOffset(T0, -7 * 3600e3));
check("shift +5:30 rolls to next day", fmtWithOffset(T0, 5.5 * 3600e3) === "2026-08-22 19:12:14", fmtWithOffset(T0, 5.5 * 3600e3));
check("shift +9h rolls month edge", fmtWithOffset("2026-08-31T20:00:00Z", 9 * 3600e3) === "2026-09-01 05:00:00");
check("invalid input passes through", fmtWithOffset("not-a-date", 0) === "not-a-date");
check("null offset treated as 0", fmtWithOffset(T0, null) === "2026-08-22 13:42:14");

console.log("== DST awareness limitation (documented behavior) ==");
// US DST 2026: springs forward 2026-03-08, falls back 2026-11-01 (America/Los_Angeles)
const winterPair = { openedAt: "2026-01-15 05:04:34", openedAtRaw: "2026-01-15 13:04:34" };
const summerPair = { openedAt: "2026-07-29 04:49:28", openedAtRaw: "2026-07-29 11:49:28" };
const wOff = detectSnOffsetMs([winterPair]);
const sOff = detectSnOffsetMs([summerPair]);
check("winter offset is -8h (PST)", wOff === -8 * 3600e3, wOff / 3600e3);
check("summer offset is -7h (PDT)", sOff === -7 * 3600e3, sOff / 3600e3);
check("single global offset cannot satisfy both (known limitation)", wOff !== sOff);

console.log(`\nunit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
