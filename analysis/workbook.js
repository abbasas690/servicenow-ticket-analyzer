function detectSnOffsetMs(rows) {
  for (const r of rows || []) {
    const disp = String(r.openedAt || "");
    const raw = String(r.openedAtRaw || "");
    if (!disp || !raw) continue;
    const de = Date.parse(disp.replace(" ", "T") + "Z");
    const re = Date.parse(raw.replace(" ", "T") + (/Z$|[+-]\d\d:?\d\d$/.test(raw) ? "" : "Z"));
    if (Number.isFinite(de) && Number.isFinite(re)) return de - re;
  }
  return 0;
}

function fmtWithOffset(v, offsetMs) {
  const d = new Date(v);
  if (isNaN(d)) return v;
  const p = n => String(n).padStart(2, "0");
  const s = new Date(d.getTime() + (offsetMs || 0));
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())} ` +
    `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}:${p(s.getUTCSeconds())}`;
}

function buildWorkbook(rows, groupName) {
  const summary = buildSummary(rows, groupName);

  const TIME_KEYS = ["assignTime", "acknTime", "suspendTime", "resumeTime", "resolvedAt"];
  const snOffsetMs = detectSnOffsetMs(rows);
  const sheetRows = rows.map(r => {
    const c = { ...r };
    for (const k of TIME_KEYS) if (c[k]) c[k] = fmtWithOffset(c[k], snOffsetMs);
    return c;
  });

  const wb = XLSX.utils.book_new();
  const ticketSheet = XLSX.utils.json_to_sheet(sheetRows, {
    header: ["number", "shortDescription", "assignedTo", "priority", "state", "assignmentGroup",
      "configItem", "incidentState", "createdOn",
      "assignTime", "acknTime", "suspendTime", "resumeTime", "resolvedAt"]
  });
  XLSX.utils.book_append_sheet(wb, ticketSheet, "Tickets");

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary.rows), "Summary");

  return wb;
}

function buildSummary(rows, groupName) {
  const countBy = key => {
    const m = {};
    for (const r of rows) m[r[key]] = (m[r[key]] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const out = [{ metric: "Exported for group", value: groupName },
               { metric: "Total tickets", value: rows.length }];

  const delays = [];
  for (const r of rows) {
    if (r.assignTime && r.acknTime) {
      const d = Date.parse(r.acknTime) - Date.parse(r.assignTime);
      if (d >= 0) delays.push(d);
    }
  }
  if (delays.length) {
    delays.sort((a, b) => a - b);
    const avg = delays.reduce((s, v) => s + v, 0) / delays.length;
    const med = delays[Math.floor(delays.length / 2)];
    out.push(
      { metric: "Tickets with ack time", value: delays.length },
      { metric: "Avg assign-to-ackn (hrs)", value: (avg / 3600000).toFixed(2) },
      { metric: "Median assign-to-ackn (hrs)", value: (med / 3600000).toFixed(2) }
    );
  }
  out.push({ metric: "", value: "" }, { metric: "By State", value: "Count" });
  for (const [k, v] of countBy("state")) out.push({ metric: k, value: v });
  out.push({ metric: "", value: "" }, { metric: "By Priority", value: "Count" });
  for (const [k, v] of countBy("priority")) out.push({ metric: k, value: v });
  const neverAcked = rows.filter(r => !r.acknTime).length;
  const neverSuspended = rows.filter(r => !r.suspendTime).length;
  out.push(
    { metric: "", value: "" },
    { metric: "Never acknowledged in queue", value: neverAcked },
    { metric: "Never went On Hold", value: neverSuspended }
  );
  return { rows: out };
}

if (typeof self !== "undefined") self.Workbook = { buildWorkbook, detectSnOffsetMs, fmtWithOffset };
if (typeof module !== "undefined") module.exports = { buildWorkbook, detectSnOffsetMs, fmtWithOffset };
