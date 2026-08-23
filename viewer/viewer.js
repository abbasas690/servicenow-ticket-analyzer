const $ = id => document.getElementById(id);

const COLUMNS = [
  ["number", "Number", "num", 120],
  ["shortDescription", "Short description", "", 260],
  ["assignedTo", "Assigned to", "", 130],
  ["priority", "Priority", "", 95],
  ["state", "State", "", 105],
  ["assignmentGroup", "Group", "", 140],
  ["configItem", "Configuration item", "", 150],
  ["incidentState", "Incident state", "", 110],
  ["createdOn", "Created", "time", 155],
  ["assignTime", "Assign time", "inst", 155],
  ["acknTime", "Ackn time", "inst", 155],
  ["suspendTime", "Suspend time", "inst", 155],
  ["resumeTime", "Resume time", "inst", 155],
  ["resolvedAt", "Resolved", "time", 155],
  ["solutionType", "Solution type", "", 115],
  ["rootCause", "Root cause", "", 230],
  ["rep:type", "Type", "rep", 85],
  ["rep:incidentHours", "Incident hours", "rep", 105],
  ["rep:incidentTotalAge", "Incident total age", "rep", 120],
  ["rep:incCurrentHours", "Inc current hours (from ASG)", "rep", 160],
  ["rep:incidentCurrentAge", "Incident current age", "rep", 130],
  ["rep:responseSLA", "Response SLA", "rep", 105],
  ["rep:cumulativeSla", "Cumulative SLA", "rep", 110],
  ["rep:cumulativeDays", "Cumulative days", "rep", 115],
  ["rep:metResponseSLA", "Met response SLA", "rep", 120],
  ["rep:metMinResolutionSLA", "Met min resolution SLA", "rep", 140],
  ["rep:metMaxResolutionSLA", "Met max resolution SLA", "rep", 140],
  ["rep:analysedDate", "Analysed date", "rep", 105]
];

let data = null;
console.log("viewer build 2026-08-24-B (fixed cols + click-to-copy)");
let sortKey = null;
let sortDir = 1;

chrome.storage.local.get(["lastData"], ({ lastData }) => load(lastData));
loadTplInfo();

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "DATA_UPDATED") {
    if (selfPush || document.querySelector("td.edit-input input")) return false;
    chrome.storage.local.get(["lastData"], ({ lastData }) => {
      load(lastData);
      setStatus("Updated from latest run");
    });
  }
  return false;
});

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.style.color = isError ? "#f87171" : "#4ade80";
  setTimeout(() => { el.textContent = ""; }, 4000);
}

const TPL_SHEET_NAME = "all_ticket_details";
const TPL_COLUMNS = [
  { col: 1, get: (r, i) => String(i + 1) },
  { col: 2, get: r => Report.buildReport(r, fmtInstant).opCo },
  { col: 3, get: r => Report.buildReport(r, fmtInstant).domain },
  { col: 4, get: r => Report.buildReport(r, fmtInstant).type },
  { col: 5, get: r => r.number },
  { col: 6, get: r => r.assignmentGroup },
  { col: 7, get: r => r.priority },
  { col: 8, get: r => r.shortDescription },
  { col: 9, get: r => r.state },
  { col: 10, get: r => r.assignedTo },
  { col: 11, get: r => Report.buildReport(r, fmtInstant).created },
  { col: 12, get: r => Report.buildReport(r, fmtInstant).assigned },
  { col: 13, get: r => Report.buildReport(r, fmtInstant).ackn },
  { col: 14, get: r => Report.buildReport(r, fmtInstant).resolved },
  { col: 15, get: r => Report.buildReport(r, fmtInstant).susp },
  { col: 16, get: r => Report.buildReport(r, fmtInstant).resumed },
  { col: 17, get: r => Report.buildReport(r, fmtInstant).impactedApplication },
  { col: 18, get: r => Report.buildReport(r, fmtInstant).resolutionType },
  { col: 19, get: r => Report.buildReport(r, fmtInstant).rootCauseCategory },
  { col: 20, get: () => "" },
  { col: 21, get: () => "" },
  { col: 22, get: () => "" },
  { col: 23, get: () => "" },
  { col: 24, get: () => "" },
  { col: 25, get: () => "" },
  { col: 26, get: r => Report.buildReport(r, fmtInstant).incidentHours },
  { col: 27, get: r => Report.buildReport(r, fmtInstant).incidentTotalAge },
  { col: 28, get: r => Report.buildReport(r, fmtInstant).incCurrentHours },
  { col: 29, get: r => Report.buildReport(r, fmtInstant).incidentCurrentAge },
  { col: 30, get: r => Report.buildReport(r, fmtInstant).responseSLA },
  { col: 31, get: r => Report.buildReport(r, fmtInstant).cumulativeSla },
  { col: 32, get: r => Report.buildReport(r, fmtInstant).cumulativeDays },
  { col: 33, get: r => Report.buildReport(r, fmtInstant).timeTaken },
  { col: 34, get: r => Report.buildReport(r, fmtInstant).metResponseSLA },
  { col: 35, get: r => Report.buildReport(r, fmtInstant).metMinResolutionSLA },
  { col: 36, get: r => Report.buildReport(r, fmtInstant).metMaxResolutionSLA },
  { col: 37, get: r => Report.buildReport(r, fmtInstant).metResponseSLA },
  { col: 38, get: r => Report.buildReport(r, fmtInstant).metMinResolutionSLA },
  { col: 39, get: r => Report.buildReport(r, fmtInstant).metMaxResolutionSLA },
  { col: 40, get: r => Report.buildReport(r, fmtInstant).analysedDate }
];

let tplInfo = null;

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function bufferFromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadTplInfo() {
  const { snXlsxTemplate: t } = await chrome.storage.local.get("snXlsxTemplate");
  tplInfo = t && t.dataB64 ? t : null;
  updateTplState();
}

function updateTplState() {
  const el = $("tplState");
  if (tplInfo) {
    el.textContent = `template: ${tplInfo.name} — click to change`;
    el.classList.add("has");
  } else {
    el.textContent = "no template yet — Export will ask for your .xlsx";
    el.classList.remove("has");
  }
}

$("tplState").addEventListener("click", async () => {
  if (!tplInfo) return;
  await chrome.storage.local.remove("snXlsxTemplate");
  tplInfo = null;
  updateTplState();
  setStatus("Template cleared — pick a new one on next export");
});

function pickTemplateFile() {
  return new Promise(resolve => {
    const inp = $("tplFile");
    inp.onchange = () => {
      const f = inp.files[0] || null;
      inp.value = "";
      resolve(f);
    };
    inp.click();
  });
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[ch]);
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function decodeText(bytes) {
  return new TextDecoder().decode(bytes);
}

function encodeText(str) {
  return new TextEncoder().encode(str);
}

function normSheetName(s) {
  return String(s).toLowerCase().replace(/[\s_]+/g, "");
}

function findTargetSheetPath(files, wanted) {
  const target = normSheetName(wanted);
  const wbXml = decodeText(files["xl/workbook.xml"] || new Uint8Array());
  const relsXml = decodeText(files["xl/_rels/workbook.xml.rels"] || new Uint8Array());
  const resolveRel = rid => {
    const relMatch = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]*)"`, "i"))
      || relsXml.match(new RegExp(`<Relationship[^>]*Target="([^"]*)"[^>]*Id="${rid}"`, "i"));
    if (!relMatch) return null;
    let t = relMatch[1].replace(/^\//, "");
    if (!t.startsWith("xl/")) t = "xl/" + t;
    return files[t] ? t : null;
  };
  for (const mode of ["exact", "loose"]) {
    const tagRe = /<sheet\b[^>]*>/g;
    let m;
    while ((m = tagRe.exec(wbXml)) !== null) {
      const nameM = m[0].match(/\bname="([^"]*)"/i);
      const ridM = m[0].match(/\br:id="([^"]*)"/i);
      if (!nameM || !ridM) continue;
      const norm = normSheetName(nameM[1]);
      if ((mode === "exact" ? norm === target : norm.includes(target))) {
        const p = resolveRel(ridM[1]);
        if (p) return p;
      }
    }
  }
  return null;
}

function parseSharedStrings(files) {
  const raw = files["xl/sharedStrings.xml"];
  if (!raw) return [];
  const xml = decodeText(raw);
  const items = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (!m[1]) { items.push(""); continue; }
    let text = "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\/>/g;
    let t;
    while ((t = tRe.exec(m[1])) !== null) text += t[1] ?? "";
    items.push(text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&"));
  }
  return items;
}

function cellDisplayValue(cellXml, sharedStrings) {
  const isMatch = cellXml.match(/<is>([\s\S]*?)<\/is>/);
  if (isMatch) {
    let text = "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\/>/g;
    let t;
    while ((t = tRe.exec(isMatch[1])) !== null) text += t[1] ?? "";
    return text;
  }
  const vMatch = cellXml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
  if (!vMatch) return "";
  if (/t="s"/.test(cellXml)) {
    const idx = parseInt(vMatch[1], 10);
    return Number.isFinite(idx) ? (sharedStrings[idx] ?? "") : "";
  }
  return vMatch[1];
}

function harvestDataCellStyles(sheetXml, startRow) {
  const openEnd = sheetXml.indexOf("</sheetData>");
  if (openEnd === -1) return {};
  const sdStart = sheetXml.lastIndexOf("<sheetData", openEnd);
  const innerStart = sheetXml.indexOf(">", sdStart) + 1;
  const inner = sheetXml.slice(innerStart, openEnd);
  const map = {};
  const rowRe = /<row\s[^>]*r="(\d+)"[\s\S]*?<\/row>/g;
  let m;
  let scanned = 0;
  while ((m = rowRe.exec(inner)) !== null) {
    const rowNum = parseInt(m[1], 10);
    if (rowNum < startRow) continue;
    if (++scanned > 50) break;
    const cellRe = /<c\s[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\/>|>)/g;
    let c;
    while ((c = cellRe.exec(m[0])) !== null) {
      const col = c[1];
      if (map[col] !== undefined) continue;
      const sM = c[0].match(/\bs="(\d+)"/);
      if (sM) map[col] = sM[1];
    }
  }
  return map;
}

function buildDataRowsXml(rows, startRow, styleMap) {
  let out = "";
  rows.forEach((row, i) => {
    let cells = "";
    for (const { col, get } of TPL_COLUMNS) {
      const letter = colLetter(col);
      const s = styleMap && styleMap[letter] !== undefined ? ` s="${styleMap[letter]}"` : "";
      const v = get(row, i);
      if (v === null || v === undefined || String(v) === "") {
        if (!s) continue;
        cells += `<c r="${letter}${startRow + i}"${s}/>`;
        continue;
      }
      cells += `<c r="${letter}${startRow + i}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    }
    out += `<row r="${startRow + i}">${cells}</row>`;
  });
  return out;
}

function patchSheetXml(sheetXml, sharedStrings, dataRowsXml, startRow, lastDataRow) {
  const dimRe = /(<dimension ref=")([^"]*)(")/;
  if (dimRe.test(sheetXml)) {
    sheetXml = sheetXml.replace(dimRe, `$1A1:AN${lastDataRow}$3`);
  }
  const sdOpen = sheetXml.search(/<sheetData\s*\/>/);
  if (sdOpen !== -1) {
    return sheetXml.replace(/<sheetData\s*\/>/, `<sheetData>${dataRowsXml}</sheetData>`);
  }
  const openEnd = sheetXml.indexOf("</sheetData>");
  if (openEnd === -1) return sheetXml;
  const sdStart = sheetXml.lastIndexOf("<sheetData", openEnd);
  const innerStart = sheetXml.indexOf(">", sdStart) + 1;
  const inner = sheetXml.slice(innerStart, openEnd);
  const keptRows = [];
  const rowRe = /<row\s[^>]*r="(\d+)"[\s\S]*?<\/row>|<row\s[^>]*r="(\d+)"[^>]*\/>/g;
  let m;
  let lastKeptEnd = 0;
  while ((m = rowRe.exec(inner)) !== null) {
    const rowNum = parseInt(m[1] || m[2], 10);
    if (rowNum < startRow && m.index >= lastKeptEnd) {
      keptRows.push(inner.slice(lastKeptEnd, m.index + m[0].length));
      lastKeptEnd = m.index + m[0].length;
    } else if (rowNum < startRow) {
      lastKeptEnd = m.index + m[0].length;
    } else {
      lastKeptEnd = Math.max(lastKeptEnd, m.index + m[0].length);
    }
  }
  if (keptRows.length === 0 && startRow > 1) {
    const firstRowMatch = inner.match(/<row\s[^>]*r="(\d+)"/);
    if (firstRowMatch) {
      const firstIdx = inner.indexOf(firstRowMatch[0]);
      keptRows.push(inner.slice(0, firstIdx));
    }
  } else if (lastKeptEnd < inner.length) {
    keptRows.push(inner.slice(lastKeptEnd));
  }
  const rebuilt = keptRows.join("") + dataRowsXml;
  return sheetXml.slice(0, innerStart) + rebuilt + sheetXml.slice(openEnd);
}

function findHeaderRowInXml(sheetXml, sharedStrings) {
  const rowRe = /<row\s[^>]*r="(\d+)"[\s\S]*?<\/row>/g;
  let m;
  while ((m = rowRe.exec(sheetXml)) !== null) {
    const rowNum = parseInt(m[1], 10);
    if (rowNum > 30) break;
    const eCell = m[0].match(new RegExp(`<c\\s[^>]*r="E${rowNum}"[\\s\\S]*?(?:<\\/c>|\\/>)`));
    if (eCell && /reference/i.test(cellDisplayValue(eCell[0], sharedStrings))) return rowNum;
  }
  return 1;
}

function stripCalcChain(files) {
  if (!files["xl/calcChain.xml"]) return;
  delete files["xl/calcChain.xml"];
  const ctKey = Object.keys(files).find(k => k.toLowerCase() === "[content_types].xml");
  if (ctKey) {
    const ct = decodeText(files[ctKey]).replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/i, "");
    files[ctKey] = encodeText(ct);
  }
  const rels = decodeText(files["xl/_rels/workbook.xml.rels"] || new Uint8Array())
    .replace(/<Relationship\b[^>]*Type="[^"]*\/calcChain"[^>]*\/>/i, "");
  if (files["xl/_rels/workbook.xml.rels"]) files["xl/_rels/workbook.xml.rels"] = encodeText(rels);
  if (files["xl/workbook.xml"]) {
    let wb = decodeText(files["xl/workbook.xml"]);
    if (/<calcPr\b[^>]*\/>/.test(wb)) {
      wb = wb.replace(/<calcPr\b([^>]*?)\s*\/>/, (m, attrs) =>
        /\bfullCalcOnLoad\s*=/.test(attrs) ? m : `<calcPr${attrs} fullCalcOnLoad="1"/>`);
    } else {
      wb = wb.replace(/<\/workbook>/, '<calcPr calcId="191028" fullCalcOnLoad="1"/></workbook>');
    }
    files["xl/workbook.xml"] = encodeText(wb);
  }
}

function fillTemplateBuffer(templateBuf, rows) {
  const files = fflate.unzipSync(new Uint8Array(templateBuf));
  const sheetPath = findTargetSheetPath(files, TPL_SHEET_NAME);
  if (!sheetPath) throw new Error('Template has no sheet named "All_ticket_details"');
  const sharedStrings = parseSharedStrings(files);
  let sheetXml = decodeText(files[sheetPath]);
  const headerRow = findHeaderRowInXml(sheetXml, sharedStrings);
  const startRow = headerRow + 1;
  const lastDataRow = startRow + rows.length - 1;
  const styleMap = harvestDataCellStyles(sheetXml, startRow);
  const dataRowsXml = buildDataRowsXml(rows, startRow, styleMap);
  sheetXml = patchSheetXml(sheetXml, sharedStrings, dataRowsXml, startRow, lastDataRow);
  files[sheetPath] = encodeText(sheetXml);
  stripCalcChain(files);
  return fflate.zipSync(files, { level: 6 });
}

function filledFilename(templateName) {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const base = templateName.replace(/\.xlsx$/i, "");
  return `${base}_filled_${stamp}.xlsx`;
}

$("exportBtn").addEventListener("click", async () => {
  if (!data || !data.rows.length) {
    setStatus("Nothing to export", true);
    return;
  }
  try {
    if (!tplInfo) {
      const f = await pickTemplateFile();
      if (!f) {
        setStatus("Export cancelled — no template selected", true);
        return;
      }
      tplInfo = { name: f.name, dataB64: b64FromBuffer(await f.arrayBuffer()), savedAt: Date.now() };
      await chrome.storage.local.set({ snXlsxTemplate: tplInfo });
      updateTplState();
    }
    setStatus("Filling template…");
    const out = fillTemplateBuffer(bufferFromB64(tplInfo.dataB64), data.rows);
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: filledFilename(tplInfo.name), saveAs: false }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    });
    setStatus(`Filled ${data.rows.length} rows`);
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, true);
  }
});

$("clearBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove("lastData");
  load(null);
  setStatus("Cleared");
});

function load(d) {
  data = d && Array.isArray(d.rows) ? d : null;
  snOffsetMs = typeof detectSnOffsetMs === "function" && data
    ? detectSnOffsetMs(data.rows)
    : (self.Workbook?.detectSnOffsetMs?.(data?.rows) || 0);
  if (autoParse()) persistEdits();
  if (!data || !data.rows.length) {
    $("wrap").classList.add("hidden");
    document.querySelector(".toolbar").classList.add("hidden");
    $("empty").classList.remove("hidden");
    return;
  }
  const missing = data.missingAudit ? ` · ${data.missingAudit} without timeline events` : "";
  const runs = data.runs || [];
  const lastRun = runs[runs.length - 1];
  let scope;
  if (runs.length) {
    const groups = [...new Set(runs.map(r => r.group))];
    scope = `${runs.length} run(s) · groups: ${groups.join(", ")}`;
  } else {
    scope = `${TABLE_LABEL(data.table)} · group "${data.group}"`;
  }
  $("meta").textContent =
    `${scope} · pulled ${data.at.slice(0, 16).replace("T", " ")}${missing}`;
  if (lastRun?.cached) {
    const badge = document.createElement("span");
    const age = lastRun.cacheAt ? ` (${Math.max(1, Math.round((Date.now() - lastRun.cacheAt) / 60000))} min old)` : "";
    badge.textContent = ` · cached data${age}`;
    badge.style.cssText = "color:#f59e0b;font-weight:600;";
    $("meta").appendChild(badge);
  }
  if (data.debug && data.debug.ticketsWithAudit === 0) {
    const warn = document.createElement("div");
    warn.style.cssText = "padding:6px 18px;color:#f59e0b;font-size:12px;";
    warn.textContent =
      "No timeline events found for any pulled ticket. Common causes: (1) the activity feed returned nothing - open a ticket's form in this instance's tab and check its Activity section renders field changes; (2) tickets were never updated through the platform; (3) list_history.do is blocked on this release. Timeline columns stay empty without feed events.";
    $("meta").after(warn);
  }
  buildHead();
  render();
}

function TABLE_LABEL(t) {
  return ({ incident: "Incident", change_request: "Change Request", problem: "Problem", sc_req_item: "RITM", sc_task: "SCTASK" })[t] || t;
}

function buildHead() {
  const table = $("tbl");
  let colgroup = table.querySelector("colgroup");
  if (!colgroup) {
    colgroup = document.createElement("colgroup");
    table.prepend(colgroup);
  }
  colgroup.innerHTML = "";
  const thead = table.tHead;
  thead.innerHTML = "";
  const tr = document.createElement("tr");
  for (const [key, label, , width] of COLUMNS) {
    const col = document.createElement("col");
    col.style.width = `${width || 130}px`;
    colgroup.appendChild(col);
    const th = document.createElement("th");
    th.textContent = label;
    if (key === sortKey) th.classList.add("sorted", ...(sortDir === -1 ? ["desc"] : []));
    th.addEventListener("click", () => {
      if (sortKey === key) sortDir = -sortDir;
      else { sortKey = key; sortDir = 1; }
      buildHead();
      render();
    });
    tr.appendChild(th);
  }
  thead.appendChild(tr);
}

function currentRows() {
  let rows = [...data.rows];
  const q = $("search").value.trim().toLowerCase();
  if (q) {
    rows = rows.filter(r =>
      COLUMNS.some(([k]) => String(r[k] ?? "").toLowerCase().includes(q))
    );
  }
  if (sortKey) {
    rows.sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      const na = Number(va), nb = Number(vb);
      if (Number.isFinite(na) && Number.isFinite(nb) && va !== "" && vb !== "") {
        return (na - nb) * sortDir;
      }
      return String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true }) * sortDir;
    });
  }
  return rows;
}

let snOffsetMs = 0;

function fmtInstant(v, row) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const p = n => String(n).padStart(2, "0");
  const off = typeof rowOffsetMs === "function"
    ? rowOffsetMs(row, snOffsetMs)
    : snOffsetMs;
  const s = new Date(d.getTime() + off);
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())} ` +
    `${p(s.getUTCHours())}:${p(s.getUTCMinutes())}:${p(s.getUTCSeconds())}`;
}

function render() {
  if (document.querySelector("td.edit-input")) return;
  const rows = currentRows();
  const tbody = $("tbl").tBodies[0];
  tbody.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.dataset.sysId = String(row.sysId ?? "");
    for (const [key,, cls] of COLUMNS) {
      const td = document.createElement("td");
      if (cls) td.className = cls;
      let v;
      if (key.startsWith("rep:")) {
        v = Report.buildReport(row, fmtInstant)[key.slice(4)] ?? "";
      } else {
        td.classList.add("editable");
        v = row[key];
        if (cls === "inst") v = fmtInstant(v, row);
        if ((cls === "time" || cls === "inst") && !v) td.classList.add("empty-time");
      }
      td.textContent = v === null || v === undefined ? "" : v;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  $("count").textContent = `${rows.length} / ${data.rows.length} tickets`;
}

let saveTimer = null;
let selfPush = false;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistEdits, 350);
}

async function persistEdits() {
  try {
    await chrome.storage.local.set({ lastData: data });
    selfPush = true;
    chrome.runtime.sendMessage({ type: "DATA_UPDATED" }).catch(() => {});
    setTimeout(() => { selfPush = false; }, 300);
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, true);
  }
}

function parseLocalInput(text) {
  const t = text.trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  const d = new Date(t);
  return isNaN(d) ? null : d;
}

function displayedValue(row, key, cls) {
  const v = row[key];
  if (cls === "inst") return fmtInstant(v, row);
  return v === null || v === undefined ? "" : String(v);
}

let activeFinish = null;

function startEdit(td) {
  if (!td.classList.contains("editable")) return;
  if (activeFinish && !activeFinish(true)) return;
  const tr = td.parentElement;
  const sysId = tr.dataset.sysId;
  const row = data.rows.find(r => String(r.sysId) === sysId);
  if (!row) return;
  const idx = [...tr.children].indexOf(td);
  const [key,, cls] = COLUMNS[idx];
  if (!key) return;

  td.classList.add("edit-input");
  const input = document.createElement("input");
  input.value = displayedValue(row, key, cls);
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();

  const finish = (commit, move) => {
    if (finish.done) return true;
    let parsed = input.value;
    if (commit && cls === "inst") {
      const t = parsed.trim();
      const d = parseLocalInput(t);
      if (!d && t) {
        td.classList.add("edit-invalid");
        return false;
      }
      parsed = d ? d.toISOString() : "";
    }
    finish.done = true;
    activeFinish = null;
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", onBlur);
    td.classList.remove("edit-input", "edit-invalid");
    input.remove();
    if (commit) {
      row[key] = parsed;
      tr.classList.add("flash");
      scheduleSave();
    }
    render();
    if (commit && move) {
      const target = moveToCell(tr.dataset.sysId, idx, move);
      if (target) startEdit(target);
    }
    return true;
  };

  const onKey = e => {
    if (e.key === "Enter") { e.preventDefault(); finish(true, { r: 1, c: 0 }); }
    else if (e.key === "Tab") { e.preventDefault(); finish(true, { r: 0, c: e.shiftKey ? -1 : 1 }); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  const onBlur = () => { finish(true); };

  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", onBlur);
  activeFinish = finish;
}

function moveToCell(sysId, colIdx, delta) {
  const tbody = $("tbl").tBodies[0];
  const trs = [...tbody.rows];
  const ri = trs.findIndex(t => t.dataset.sysId === sysId);
  const ci = colIdx + delta.c;
  const rt = trs[ri + delta.r];
  if (!rt || ci < 0 || ci >= COLUMNS.length) return null;
  return rt.children[ci];
}

$("tbl").tBodies[0].addEventListener("click", e => {
  const td = e.target.closest("td");
  if (!td || td.classList.contains("editable")) return;
  const tr = td.parentElement;
  const row = data?.rows.find(r => String(r.sysId) === tr.dataset.sysId);
  if (!row) return;
  const idx = [...tr.children].indexOf(td);
  const [key,, cls] = COLUMNS[idx];
  if (!key) return;
  const text = cellValue(row, key, cls);
  if (!text) return;
  navigator.clipboard.writeText(text)
    .then(() => setStatus(`Copied: ${text.length > 60 ? text.slice(0, 60) + "…" : text}`))
    .catch(err => setStatus(`Copy failed: ${err.message}`, true));
});

$("tbl").tBodies[0].addEventListener("dblclick", e => {
  const td = e.target.closest("td");
  if (td) startEdit(td);
});

$("search").addEventListener("input", render);

function autoParse() {
  if (!data || !Array.isArray(data.rows)) return 0;
  let filled = 0;
  for (const row of data.rows) {
    if (!(row.closeNotes || "").trim()) continue;
    if (row.solutionType && row.rootCause) continue;
    const h = AiExtract.extractHeuristic(row.closeNotes);
    if (h.solutionType || h.rootCause) {
      row.solutionType = row.solutionType || h.solutionType;
      row.rootCause = row.rootCause || h.rootCause;
      filled++;
    }
  }
  return filled;
}
