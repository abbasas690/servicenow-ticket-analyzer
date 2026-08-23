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
const auditRow = (key, i) => ({
  documentkey: key,
  fieldname: "assigned_to",
  oldvalue: "",
  newvalue: "MEM1",
  sys_created_on: `2026-08-23 06:0${i}:00`
});
const histRow = (id, i) => ({
  id,
  field: "assignment_group",
  old: "",
  new: "Q1",
  old_value: "",
  new_value: "",
  update_time: `2026-08-23 07:0${i}:00`,
  sys_created_on: `2026-08-23 07:0${i}:05`
});
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

(async () => {
  console.log("== chain step 1: batched sys_audit works ==");
  let t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: JSON.stringify({ result: url.includes("/sys_audit") && url.includes("documentkeyIN")
      ? [auditRow("AAA", 1), auditRow("BBB", 2)] : [] })
  }));
  let c = mkClient(t);
  let got = await c.fetchAudit(["AAA", "BBB"], FIELDS);
  check("both tickets via single IN call", Object.keys(got).sort().join() === "AAA,BBB");
  check("no per-ticket or history requests", !t.calls.some(u => /documentkey=[A-Z]|sys_history_line/.test(u)));
  check("source = audit-batched", c.auditSource === "audit-batched");

  console.log("== chain step 2: IN blocked -> per-ticket sys_audit ==");
  t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: JSON.stringify({ result: url.includes("/sys_audit") && /documentkey=[A-Z]/.test(url)
      ? [auditRow(/documentkey=([A-Z]+)/.exec(url)[1], 5)] : [] })
  }));
  const diags2 = [];
  c = mkClient(t, diags2);
  got = await c.fetchAudit(["AAA", "BBB", "CCC"], FIELDS);
  check("all three tickets populated", Object.keys(got).sort().join() === "AAA,BBB,CCC");
  check("probe + 3 equality reads", t.calls.filter(u => /documentkey=[A-Z]/.test(u)).length === 4);
  check("source = audit-perTicket", c.auditSource === "audit-perTicket" && c.auditInBlocked === true);
  check("fallback diagnostic emitted", diags2.some(d => d.kind === "warn" && /per-ticket reads/.test(d.note || "")));

  console.log("== chain step 3: sys_audit dead entirely -> history batched ==");
  t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: JSON.stringify({
      result: url.includes("/sys_history_line") && url.includes("idIN")
        ? [histRow("AAA", 1), histRow("BBB", 2)]
        : []
    })
  }));
  const diags3 = [];
  c = mkClient(t, diags3);
  got = await c.fetchAudit(["AAA", "BBB"], FIELDS);
  check("tickets sourced from history lines", Object.keys(got).sort().join() === "AAA,BBB");
  check("event shape normalized (field/at)", got.AAA[0].field === "assignment_group" && !!got.AAA[0].at);
  check("display value kept when raw empty", got.AAA[0].newValue === "Q1");
  check("source = history-batched", c.auditSource === "history-batched");
  check("switch-over note emitted", diags3.some(d => d.kind === "warn" && /switching to sys_history_line/.test(d.note || "")));

  console.log("== memoized: next run goes straight to history ==");
  const before = t.calls.length;
  await c.fetchAudit(["CCC"], FIELDS);
  check("no sys_audit request on second call", !t.calls.slice(before).some(u => u.includes("/sys_audit")));

  console.log("== chain step 4: history IN blocked too -> per-ticket history ==");
  t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: JSON.stringify({ result: url.includes("/sys_history_line") && /id=[A-Z]/.test(url)
      ? [histRow(/id=([A-Z]+)/.exec(url)[1], 7)] : [] })
  }));
  const diags4 = [];
  c = mkClient(t, diags4);
  got = await c.fetchAudit(["AAA", "BBB"], FIELDS);
  check("per-ticket history reads used", Object.keys(got).sort().join() === "AAA,BBB");
  check("source = history-perTicket", c.auditSource === "history-perTicket");
  check("second rejection note emitted", diags4.some(d => d.kind === "warn" && /batched queries rejected too/.test(d.note || "")));

  console.log("== nothing anywhere ==");
  t = mkTransport(async () => ({ ok: true, status: 200, via: "mock", hadToken: true, text: JSON.stringify({ result: [] }) }));
  const diags5 = [];
  c = mkClient(t, diags5);
  got = await c.fetchAudit(["AAA"], FIELDS);
  check("empty map returned", Object.keys(got).length === 0);
  check("final give-up note", diags5.some(d => d.kind === "warn" && /timelines will stay empty/.test(d.note || "")));

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

  console.log(`\naudit-chain: ${failed ? failed + " FAILED" : "all passed"}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
