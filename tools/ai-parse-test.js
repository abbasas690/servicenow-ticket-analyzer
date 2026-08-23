#!/usr/bin/env node
const { buildClosurePrompt, parseClosureJson, classifySolution } = require("../analysis/aiextract.js");

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

console.log("== classifySolution ==");
check("permanent", classifySolution("Permanent fix"), "Permanent fix");
check("typo permanent", classifySolution("permanant"), "Permanent fix");
check("workaround", classifySolution("Workaround"), "Workaround");
check("work around spaced", classifySolution("work around applied"), "Workaround");
check("temporary", classifySolution("Temporary - monitoring"), "Workaround");
check("empty", classifySolution(""), "");
check("garbage", classifySolution("banana"), "");

console.log("== parseClosureJson ==");
check("clean json",
  parseClosureJson('{"solution_type":"Permanent fix","root_cause":"Disk full due to log growth"}'),
  { solutionType: "Permanent fix", rootCause: "Disk full due to log growth" });
check("markdown fenced",
  parseClosureJson('```json\n{"solution_type":"Workaround","root_cause":"Vendor patch pending"}\n```'),
  { solutionType: "Workaround", rootCause: "Vendor patch pending" });
check("prose before/after json",
  parseClosureJson('Here is the result:\n{"solution_type":"Workaround","root_cause":"Restarted service"} hope this helps!'),
  { solutionType: "Workaround", rootCause: "Restarted service" });
check("think block stripped",
  parseClosureJson('<think>let me analyze</think>{"solution_type":"Permanent fix","root_cause":"Bad config"}'),
  { solutionType: "Permanent fix", rootCause: "Bad config" });
check("alt keys is_permanent bool",
  parseClosureJson('{"is_permanent": true, "root_cause": "Code defect fixed in v2"}'),
  { solutionType: "Permanent fix", rootCause: "Code defect fixed in v2" });
check("camelCase keys",
  parseClosureJson('{"solutionType":"workaround","rootCause":"Cache flush needed after reboot"}'),
  { solutionType: "Workaround", rootCause: "Cache flush needed after reboot" });
check("root cause unknown blanked",
  parseClosureJson('{"solution_type":"Permanent fix","root_cause":"Unknown"}'),
  { solutionType: "Permanent fix", rootCause: "" });
check("root cause label prefix stripped",
  parseClosureJson('{"solution_type":"Permanent Fix","root_cause":"Root cause: memory leak in module X"}'),
  { solutionType: "Permanent fix", rootCause: "memory leak in module X" });
check("regex fallback without braces",
  parseClosureJson('solution type: workaround; root cause: upstream API outage'),
  { solutionType: "Workaround", rootCause: "upstream API outage" });
check("junk safe",
  parseClosureJson("no json at all here"),
  { solutionType: "", rootCause: "" });
check("empty input safe",
  parseClosureJson(""),
  { solutionType: "", rootCause: "" });

console.log("== buildClosurePrompt ==");
const msgs = buildClosurePrompt("the issue: app down\nsteps taken: restart\nis it permanent solution: no\nroot cause: OOM");
check("two messages", msgs.length === 2, true);
check("notes embedded", msgs[1].content.includes("OOM"), true);
check("json schema demanded", /solution_type/.test(msgs[0].content), true);

console.log(`\nai-extract: ${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
