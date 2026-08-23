"use strict";
const { extractEventsFromActivity } = require("../analysis/phase2.js");

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.error(`FAIL - ${name}${extra ? " :: " + extra : ""}`);
  }
}

const prose = extractEventsFromActivity([
  { author: "ravi", text: "Assignment group changed from Network to APPSUP_INFORM on 2026-08-23 06:06:43" },
  { html: 'State changed from New to In Progress <span>10-08-2026 11:06:40</span>' },
  { note: 'Assigned to changed from Unassigned to "Ravi Jeldi" on 08/23/2026 06:06 AM' }
]);

check("prose group change", prose.some(e =>
  e.field === "assignment_group" && e.oldValue === "Network" &&
  e.newValue === "APPSUP_INFORM" && e.at === "2026-08-23T06:06:43.000Z"),
  JSON.stringify(prose));
check("html state change dd-mm", prose.some(e =>
  e.field === "state" && e.oldValue === "New" && e.newValue === "In Progress" &&
  e.at === "2026-08-10T11:06:40.000Z"));
check("prose assigned_to mm/dd am/pm", prose.some(e =>
  e.field === "assigned_to" && e.newValue === "Ravi Jeldi"));

const structured = extractEventsFromActivity([
  { changes: [
    { label: "Assignment group", old_value: "A", new_value: "B", timestamp: "2026-01-05 10:00:00" },
    { label: "Priority", old_value: "3", new_value: "2", timestamp: "2026-01-05 10:00:01" }
  ] }
]);
check("structured changes parsed", structured.length === 1 &&
  structured[0].field === "assignment_group" && structured[0].newValue === "B");
check("non-timeline labels ignored", !structured.some(e => e.field === "priority"));

check("relative-time-only skipped", extractEventsFromActivity([
  { text: "Assigned to changed from A to B, updated 2 hours ago" }
]).length === 0);

check("undated structured skipped", extractEventsFromActivity([
  { changes: [{ label: "Assigned to", old_value: "X", new_value: "Y" }] }
]).length === 0);

const dupes = extractEventsFromActivity([
  { text: "Assignment group changed from N to Q on 2026-03-03 12:00:00" },
  { text: "Assignment group changed from N to Q on 2026-03-03 12:00:00" }
]);
check("duplicates deduped", dupes.length === 1);

check("empty input safe", extractEventsFromActivity([]).length === 0);
check("junk input safe", extractEventsFromActivity([null, "str", 42, {}]).length === 0);

process.exit(failures ? 1 : 0);
