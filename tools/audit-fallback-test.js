#!/usr/bin/env node
const { ServiceNowClient } = require("../lib/servicenow.js");

let failed = 0;
function check(name, cond) {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok " : "FAIL"} ${name}`);
}
const FIELDS = ["assignment_group", "assigned_to", "state"];
const auditRow = (key, i) => ({
  documentkey: key,
  fieldname: "assigned_to",
  oldvalue: "",
  newvalue: "MEM1",
  sys_created_on: `2026-08-23 06:0${i}:00`
});
const dec = u => decodeURIComponent(u);
const mkTransport = handler => {
  const calls = [];
  const fn = async target => {
    calls.push(dec(target));
    return handler(dec(target), calls.length);
  };
  fn.calls = calls;
  return fn;
};
const mkClient = t => new ServiceNowClient("https://x.service-now.com", { transport: t });

(async () => {
  console.log("== batched IN works (normal instances) ==");
  let t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: JSON.stringify({
      result: url.includes("documentkeyIN")
        ? [auditRow("AAA", 1), auditRow("BBB", 2)]
        : [auditRow("AAA", 3)]
    })
  }));
  let c = mkClient(t);
  let got = await c.fetchAudit(["AAA", "BBB"], FIELDS);
  check("both tickets populated via single IN call", Object.keys(got).sort().join() === "AAA,BBB");
  check("no per-ticket requests made", !t.calls.some(u => /documentkey=[A-Z]/.test(u)));
  check("auditInBlocked stays false", c.auditInBlocked !== true);

  console.log("== IN silently blocked -> auto fallback ==");
  t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: JSON.stringify({ result: url.includes("documentkey=") ? [auditRow(/documentkey=([A-Z]+)/.exec(url)[1], 5)] : [] })
  }));
  const diags = [];
  c = new ServiceNowClient("https://x.service-now.com", {
    transport: t,
    onDiagnostic: d => diags.push(d)
  });
  got = await c.fetchAudit(["AAA", "BBB", "CCC"], FIELDS);
  check("fallback returned all three tickets", Object.keys(got).sort().join() === "AAA,BBB,CCC");
  check("per-ticket equality reads used", t.calls.filter(u => /documentkey=[A-Z]{3}/.test(u)).length === 4); // 1 probe + 3 tickets
  check("flag memoized", c.auditInBlocked === true);
  check("fallback diagnostic emitted", diags.some(d => d.kind === "warn" && /per-ticket/.test(d.note || "")));

  console.log("== genuinely zero audit everywhere ==");
  t = mkTransport(async () => ({ ok: true, status: 200, via: "mock", hadToken: true, text: JSON.stringify({ result: [] }) }));
  c = mkClient(t);
  got = await c.fetchAudit(["AAA"], FIELDS);
  check("returns empty map without fallback storm", Object.keys(got).length === 0);
  check("exactly one probe request", t.calls.filter(u => /documentkey=/.test(u)).length === 1);

  console.log("== memoized skip on next run ==");
  t = mkTransport(async url => ({
    ok: true, status: 200, via: "mock", hadToken: true,
    text: JSON.stringify({ result: url.includes("documentkey=") ? [auditRow(/documentkey=([A-Z]+)/.exec(url)[1], 9)] : [auditRow("XXX", 9)] })
  }));
  c = mkClient(t);
  c.auditInBlocked = true;
  got = await c.fetchAudit(["YYY", "ZZZ"], FIELDS);
  check("goes straight to per-ticket, ignores poisoned IN response",
    Object.keys(got).length === 2 && !t.calls.some(u => u.includes("documentkeyIN")));

  console.log(`\naudit-fallback: ${failed ? failed + " FAILED" : "all passed"}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
