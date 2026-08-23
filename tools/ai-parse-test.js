#!/usr/bin/env node
const { buildClosurePrompt, parseClosureJson, classifySolution, extractHeuristic } = require("../analysis/aiextract.js");

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

console.log("== extractHeuristic (regex fast-path) ==");
check("labeled permanent note fully resolved",
  extractHeuristic(`the issue: Users could not log in.
steps taken to resolve: Replaced the expired SAML certificate.
is it permanent solution: Yes
root cause: Expired SAML signing certificate`),
  { solutionType: "Permanent fix", rootCause: "Expired SAML signing certificate" });
check("labeled No resolves to workaround",
  extractHeuristic(`the issue: Report page timed out.
steps taken to resolve: Restarted the reporting worker.
is it permanent solution: No - monitoring for now
root cause: Memory leak in worker`),
  { solutionType: "Workaround", rootCause: "Memory leak in worker" });
check("prose permanent fix + labeled root cause",
  extractHeuristic(`Search returned no results. Rebuilt the index and verified. This is a permanent fix.
Root cause: index rebuild step missing from upgrade runbook.`),
  { solutionType: "Permanent fix", rootCause: "index rebuild step missing from upgrade runbook" });
check("root cause was/is sentence form",
  extractHeuristic("Permanent solution applied at root cause level. Root cause was unbounded connection growth from misconfigured cron."),
  { solutionType: "Permanent fix", rootCause: "unbounded connection growth from misconfigured cron" });
check("vague restart note yields nothing (goes to AI)",
  extractHeuristic("Restarted the server, everything is working fine now."),
  { solutionType: "", rootCause: "" });
check("temporary keyword partial (no root cause -> AI fills)",
  extractHeuristic("Cleared paper jam and reinstalled driver as temporary measure."),
  { solutionType: "Workaround", rootCause: "" });
check("vendor deferral wording detected",
  extractHeuristic(`Disabled the failing integration until vendor provides a patch.
root cause: Vendor API returns 500 on batch payloads larger than 100 records`),
  { solutionType: "Workaround", rootCause: "Vendor API returns 500 on batch payloads larger than 100 records" });

console.log(`\nai-extract: ${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
