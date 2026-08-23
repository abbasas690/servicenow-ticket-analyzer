#!/usr/bin/env node
const { extractHeuristic } = require("../analysis/aiextract.js");

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

console.log("== extractHeuristic (regex) ==");
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
check("vague restart note yields nothing",
  extractHeuristic("Restarted the server, everything is working fine now."),
  { solutionType: "", rootCause: "" });
check("temporary keyword partial (no root cause)",
  extractHeuristic("Cleared paper jam and reinstalled driver as temporary measure."),
  { solutionType: "Workaround", rootCause: "" });
check("vendor deferral wording detected",
  extractHeuristic(`Disabled the failing integration until vendor provides a patch.
root cause: Vendor API returns 500 on batch payloads larger than 100 records`),
  { solutionType: "Workaround", rootCause: "Vendor API returns 500 on batch payloads larger than 100 records" });

console.log(`\nai-extract: ${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
