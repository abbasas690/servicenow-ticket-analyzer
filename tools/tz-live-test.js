#!/usr/bin/env node
const { detectSnOffsetMs, rowOffsetMs, fmtWithOffset } = require("../analysis/workbook.js");

const INSTANCE = (process.env.TZ_INSTANCE || process.env.SEED_INSTANCE || "").replace(/\/+$/, "");
const USER = process.env.TZ_USER || process.env.SEED_USER || "";
const PASS = process.env.TZ_PASS || process.env.SEED_PASS || "";
if (!INSTANCE || !USER || !PASS) {
  console.error("Usage: TZ_INSTANCE=... TZ_USER=... TZ_PASS=... node tools/tz-live-test.js");
  process.exit(2);
}

async function api(path, params) {
  const url = new URL(INSTANCE + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"), Accept: "application/json" }
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()).result;
}
const val = v => (v && typeof v === "object") ? (v.value || "") : String(v ?? "");

(async () => {
  let fail = 0;

  console.log("== A. scenario tickets: viewer pipeline vs ServiceNow's own clock ==");
  const recs = await api("/api/now/table/incident", {
    sysparm_query: "short_descriptionSTARTSWITH[SCEN^ORDERBYnumber",
    sysparm_fields: "sys_id,number,opened_at", sysparm_display_value: "all", sysparm_limit: 100
  });
  const global = detectSnOffsetMs(recs.map(r => ({
    openedAt: r.opened_at?.display_value || "", openedAtRaw: r.opened_at?.value || ""
  })));
  console.log(`  global detectSnOffsetMs = ${global / 3600e3}h`);
  let checked = 0;
  for (const r of recs) {
    const disp = r.opened_at?.display_value || "";
    const raw = val(r.opened_at);
    if (!disp || !raw) continue;
    const rowOff = rowOffsetMs({ openedAt: disp, openedAtRaw: raw }, global);
    const rendered = fmtWithOffset(raw.replace(" ", "T") + "Z", rowOff);
    checked++;
    if (rendered !== disp) {
      fail++;
      console.log(`  FAIL ${val(r.number)} rendered=${rendered} sn-display=${disp}`);
    }
  }
  console.log(`  ${checked} tickets: rendered opened_at === SN display value ${fail ? "" : "(exact match)"}`);

  console.log("\n== B. cross-DST tickets (old data, other season) ==");
  const oob = await api("/api/now/table/incident", {
    sysparm_query: "numberININC0000017,INC0000060,INC0008001,INC0000001",
    sysparm_fields: "number,opened_at", sysparm_display_value: "all", sysparm_limit: 10
  });
  for (const r of oob) {
    const disp = r.opened_at?.display_value || "";
    const raw = val(r.opened_at);
    if (!disp || !raw) continue;
    const rowOff = rowOffsetMs({ openedAt: disp, openedAtRaw: raw }, global);
    const rendered = fmtWithOffset(raw.replace(" ", "T") + "Z", rowOff);
    const oldWay = fmtWithOffset(raw.replace(" ", "T") + "Z", global);
    const okNow = rendered === disp;
    const deltaMin = Math.round((Date.parse(oldWay.replace(" ", "T") + "Z") - Date.parse(disp.replace(" ", "T") + "Z")) / 60e3);
    console.log(`  ${val(r.number)} SN-display=${disp}  per-row=${okNow ? "MATCH" : `FAIL (${rendered})`}  ${deltaMin ? `(old fixed-offset way was off by ${Math.abs(deltaMin)}min)` : "(fixed-offset also matched)"}`);
    if (!okNow) fail++;
  }

  console.log(`\nlive: ${fail === 0 ? "viewer output identical to ServiceNow Activity-UI clock" : fail + " mismatches"}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
