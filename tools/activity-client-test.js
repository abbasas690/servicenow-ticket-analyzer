#!/usr/bin/env node
const { ServiceNowClient } = require("../lib/servicenow.js");
const { normalizeAuditRefs } = require("../analysis/phase2.js");

let failed = 0;
function check(name, cond) {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok " : "FAIL"} ${name}`);
}
const dec = u => decodeURIComponent(u);
const FIELDS = ["assignment_group", "assigned_to", "state"];
const mkTransport = handler => {
  const calls = [];
  const fn = async target => {
    calls.push(dec(target));
    return handler(dec(target), calls.length);
  };
  fn.calls = calls;
  return fn;
};
const mkClient = (t, diags) => new ServiceNowClient("https://x.service-now.com", {
  transport: t,
  onDiagnostic: d => diags && diags.push(d)
});
const lhPayload = id => JSON.stringify({
  display_value: "Incident",
  entries: [{
    document_id: id,
    sys_created_on: "2026-08-23 06:06:43",
    sys_created_on_adjusted: "2026-08-22 23:06:43",
    entries: { journal: [], custom: [], changes: [
      { field_name: "incident_state", old_value: "New", new_value: "In Progress" },
      { field_name: "close_notes", old_value: "", new_value: "seeded" }
    ] }
  }]
});

(async () => {
  console.log("== activity primary: list_history.do full-load ==");
  let t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: url.includes("/list_history.do")
      ? lhPayload(/sys_id=([A-Z]+)/.exec(url)?.[1] || "AAA")
      : JSON.stringify({ result: [] })
  }));
  let c = mkClient(t);
  const progress = [];
  let got = await c.fetchTimelineEvents(["AAA", "BBB"], FIELDS, p => progress.push(p));
  check("only list_history.do called", t.calls.every(u => u.includes("/list_history.do")));
  check("probe reused - one call per ticket", t.calls.filter(u => u.includes("/list_history.do")).length === 2);
  check("no timestamp param sent (full dump)", !t.calls.some(u => /sysparm_timestamp/.test(u)));
  check("incident_state mapped to state", got.AAA.some(e => e.field === "state" && e.newValue === "In Progress"));
  check("non-timeline fields filtered", !got.AAA.some(e => e.field === "close_notes"));
  check("raw UTC timestamp kept", got.AAA[0].at === "2026-08-23 06:06:43");
  check("progress reported per ticket", progress.length === 2);
  check("source memoized list-history", c.activitySource === "list-history");

  console.log("== list_history.do broken -> falls back to activity/stream ==");
  t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: url.includes("/list_history.do") ? "<html>nope</html>" : JSON.stringify({
      result: { entries: [
        { author: "x", text: "Assignment group changed from N to Q on 2026-08-23 06:06:43" },
        { changes: [{ label: "Assigned to", old_value: "", new_value: "Ravi", timestamp: "2026-08-23 06:07:00" }] }
      ] }
    })
  }));
  const diagsA = [];
  c = mkClient(t, diagsA);
  got = await c.fetchTimelineEvents(["AAA"], FIELDS);
  check("both endpoints tried", t.calls.some(u => u.includes("/list_history.do")) &&
    t.calls.some(u => u.includes("/api/now/v1/activity/stream")));
  check("stream events parsed after fallback", got.AAA.length === 2);
  check("fallback note emitted", diagsA.some(d => d.kind === "warn" && /using \/api\/now\/v1\/activity\/stream/.test(d.note || "")));

  console.log("== empty feed warns but succeeds ==");
  t = mkTransport(async () => ({ ok: true, status: 200, via: "mock", hadToken: true, text: lhPayload("ZZZ") }));
  const diagsE = [];
  c = mkClient(t, diagsE);
  got = await c.fetchTimelineEvents(["AAA"], FIELDS);
  check("empty map for unmatched doc_id", Object.keys(got).length === 0);
  check("empty-feed note emitted", diagsE.some(d => d.kind === "warn" && /yielded no field changes/.test(d.note || "")));

  console.log("== zero tickets short-circuits ==");
  t = mkTransport(async () => ({ ok: true, status: 200, via: "mock", hadToken: true, text: "{}" }));
  c = mkClient(t);
  got = await c.fetchTimelineEvents([], FIELDS);
  check("no requests for empty input", t.calls.length === 0 && Object.keys(got).length === 0);

  console.log("== normalizeAuditRefs ==");
  const pairs = [
    { name: "SN QA Queue Alpha", sysId: "Q1ID" },
    { name: "Abel Tuter", sysId: "MEM1" }
  ];
  const data = {
    T1: [
      { field: "assignment_group", oldValue: "", newValue: "SN QA Queue Alpha" },
      { field: "assigned_to", oldValue: "abel tuter", newValue: "aa11bb22cc33dd44ee55ff6600112233" },
      { field: "state", oldValue: "", newValue: "In Progress" }
    ]
  };
  normalizeAuditRefs(data, pairs);
  check("queue name mapped to sys_id", data.T1[0].newValue === "Q1ID");
  check("member name mapped case-insensitively", data.T1[1].oldValue === "MEM1");
  check("32-hex ids untouched", data.T1[1].newValue === "aa11bb22cc33dd44ee55ff6600112233");
  check("state field not rewritten", data.T1[2].newValue === "In Progress");

  console.log(`\nactivity-client: ${failed ? failed + " FAILED" : "all passed"}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
