#!/usr/bin/env node
const R = require("../analysis/report.js");

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

console.log("== deriveType ==");
check("INC", R.deriveType("INC0010001"), "Incident");
check("REQ", R.deriveType("REQ0010001"), "RFS");
check("PTASK", R.deriveType("PTASK0010001"), "Problem");
check("empty", R.deriveType(""), "");
check("unknown", R.deriveType("CHG0030001"), "");

console.log("== normDate ==");
check("iso to day-first", R.normDate("2026-08-10 05:36:40"), "10-08-2026 05:36:40");
check("T separator", R.normDate("2026-08-10T05:36"), "10-08-2026 05:36");
check("already day-first", R.normDate("10-08-2026 05:36:40"), "10-08-2026 05:36:40");

console.log("== SLA priority ==");
check("P1", R.slaPriority("1 - Critical"), 1);
check("P4", R.slaPriority("4 - Low"), 4);
check("P5 clamps to 4", R.slaPriority("5 - Planning"), 4);
check("garbage", R.slaPriority(""), 0);

console.log("== business hours ==");
// Mon 2026-08-10; 08:00-17:00 = 9h/day
check("same day inside hours", R.businessHoursBetween("10-08-2026 09:00:00", "10-08-2026 12:00:00"), 3);
check("over working days", R.businessHoursBetween("14-08-2026 16:00:00", "17-08-2026 10:00:00"), 3);
check("P1 elapsed ignores biz hours",
  R.calcBusinessHours("10-08-2026 09:00:00", "10-08-2026 13:00:00", "", "", "1 - Critical"), "4.00");
check("P3 biz hours minus suspension",
  R.calcBusinessHours("10-08-2026 08:00:00", "11-08-2026 17:00:00", "10-08-2026 12:00:00", "10-08-2026 14:00:00", "3 - Moderate"), "16.00");
check("suspended not resumed stops clock at suspend (P3)",
  R.calcIncCurrentHours("10-08-2026 09:00:00", "", "10-08-2026 12:00:00", "", "3 - Moderate"), "3.00");

console.log("== response SLA ==");
check("P1 simple hms", R.calcResponseSLA("10-08-2026 09:00:00", "10-08-2026 10:30:00", "", "", "1"), "1:30:00");
check("no ackn -> empty", R.calcResponseSLA("", "10-08-2026 10:30:00", "", "", "1"), "");

console.log("== met flags ==");
check("met max", R.metSLA(3, "2 - High", "max"), "YES");
check("miss min", R.metSLA(5, "2 - High", "min"), "NO");
check("hms to hours", R.hmsToHours("1:30:00"), 1.5);

console.log("== buildReport ==");
const row = {
  number: "INC0010001", priority: "2 - High", state: "Resolved",
  assignmentGroup: "QA Queue Alpha", configItem: "App A",
  createdOn: "2026-08-10 09:00:00",
  assignTime: "2026-08-10T01:00:00.000Z", acknTime: "2026-08-10T02:00:00.000Z",
  resolvedAt: "2026-08-10 15:00:00", solutionType: "Permanent fix", rootCause: "Bad config"
};
const fmt = v => v; // already yyyy-MM-dd HH:mm:ss
const rep = R.buildReport(row, fmt);
check("type", rep.type, "Incident");
check("opCo", rep.opCo, "BA");
check("created normalized", rep.created, "10-08-2026 09:00:00");
check("assigned normalized", rep.assigned, "10-08-2026 01:00:00");
check("incident hours P2 elapsed", rep.incidentHours, "6.00");
check("total age /9", rep.incidentTotalAge, "0.67");
check("response sla", rep.responseSLA, "1:00:00");
check("met response (2<=4)", rep.metResponseSLA, "YES");
check("met min (6>4)", rep.metMinResolutionSLA, "NO");
check("met max (6<=8)", rep.metMaxResolutionSLA, "YES");
check("analysed date shape", /^\d{2}\/\d{2}\/\d{4}$/.test(rep.analysedDate), true);

console.log(`\nreport: ${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
