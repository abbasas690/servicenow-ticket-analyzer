const $ = id => document.getElementById(id);

const els = {
  instance: $("instance"), connect: $("connectBtn"), connState: $("connState"),
  ticketType: $("ticketType"),
  rawQuery: $("rawQuery"), generatedQuery: $("generatedQuery"), advancedBox: $("advancedBox"),
  filterListCard: $("filterListCard"), filterListBox: $("filterListBox"), addFilterBtn: $("addFilterBtn"),
  condRows: $("condRows"), addCondBtn: $("addCondBtn"),
  preview: $("previewBtn"), runBtn: $("runBtn"),
  progressWrap: $("progressWrap"), fill: $("fill"), stageLabel: $("stageLabel"),
  viewBtn: $("viewBtn"),
  logCard: $("logCard"), log: $("log"), lastRun: $("lastRun"),
  logHead: $("logHead"), logErrBadge: $("logErrBadge"),
  logModal: $("logModal"), logMirror: $("logMirror"), logClose: $("logClose"), logCopy: $("logCopy")
};

const TABLE_LABELS = {
  incident: "Incident",
  change_request: "Change Request",
  problem: "Problem",
  sc_req_item: "Requested Item (RITM)",
  sc_task: "Catalog Task (SCTASK)"
};

let busy = false;

function choiceList(key) {
  if (key === "states") return snStateChoices(els.ticketType.value);
  if (key === "incidentStates") return snStateChoices("incident");
  if (key === "priorities") return SN_PRIORITY_CHOICES;
  return [];
}

const COND_FIELDS = [
  { key: "assignedTo", label: "Assigned to", field: "assigned_to", type: "ref" },
  { key: "state", label: "State", field: "state", type: "choice", choicesKey: "states" },
  { key: "priority", label: "Priority", field: "priority", type: "choice", choicesKey: "priorities" },
  { key: "incidentState", label: "Incident state", field: "incident_state", type: "choice", choicesKey: "incidentStates", tables: ["incident"] },
  { key: "group", label: "Group", field: "assignment_group", type: "ref" },
  { key: "configItem", label: "Configuration item", field: "cmdb_ci", type: "string" },
  { key: "shortDescription", label: "Short description", field: "short_description", type: "string" },
  { key: "number", label: "Number", field: "number", type: "string" },
  { key: "createdOn", label: "Created", field: "sys_created_on", type: "date" },
  { key: "closedOn", label: "Closed", field: "closed_at", type: "date", tables: ["incident", "problem", "sc_req_item", "sc_task"] },
  { key: "resolvedOn", label: "Resolved", field: "resolved_at", type: "date", tables: ["incident", "problem", "sc_req_item"] }
];

let cfgQueues = [];
let cfgMembers = [];

const toEntry = m => {
  if (typeof m === "string") return { name: m, sysId: "" };
  if (m && typeof m === "object" && m.name) return { name: String(m.name), sysId: String(m.sysId || "") };
  return null;
};

function legacySnGroupQueues() {
  try {
    const raw = localStorage.getItem("snGroup");
    if (!raw) return [];
    const p = JSON.parse(raw);
    const arr = Array.isArray(p) ? p : [p];
    return arr.filter(Boolean).map(v => ({ name: String(v), sysId: "" }));
  } catch {
    return [];
  }
}

async function applyPluginSettings() {
  const { pluginSettings: s } = await chrome.storage.local.get("pluginSettings");
  if (s) {
    if (!els.instance.value && s.instanceUrl) els.instance.value = s.instanceUrl;
    if (s.defaults?.ticketType && [...els.ticketType.options].some(o => o.value === s.defaults.ticketType)) {
      els.ticketType.value = s.defaults.ticketType;
    }
    const rawQueues = Array.isArray(s.defaults?.queues) && s.defaults.queues.length
      ? s.defaults.queues
      : (s.defaults?.queueName ? [{ name: s.defaults.queueName, sysId: "" }] : legacySnGroupQueues());
    cfgQueues = rawQueues.map(toEntry).filter(Boolean);
    cfgMembers = (Array.isArray(s.defaults?.teamMembers) ? s.defaults.teamMembers : [])
      .map(toEntry).filter(Boolean);
  }
  renderCondRows();
  refreshGenerated();
}

$("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.local.get(["snInstance", "lastRun"], async cfg => {
  await applyPluginSettings();
  if (cfg.snInstance && !els.instance.value) els.instance.value = cfg.snInstance;
  const effective = els.instance.value || cfg.snInstance;
  if (effective) {
    els.instance.value = effective;
    refreshGenerated();
    connect();
  } else {
    const detected = await detectInstanceFromTabs();
    if (detected) {
      els.instance.value = detected;
      log(`Detected instance from open tab: ${detected}`);
      connect();
    }
  }
  if (cfg.lastRun) {
    els.lastRun.textContent =
      `Last export: ${cfg.lastRun.tickets} tickets for "${cfg.lastRun.group}" · ${cfg.lastRun.at.slice(0, 16).replace("T", " ")}`;
  }
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.pluginSettings) applyPluginSettings();
});

async function detectInstanceFromTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://*.service-now.com/*" });
    if (!tabs.length) return null;
    const recent = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    return new URL(recent.url).origin;
  } catch {
    return null;
  }
}

function instanceUrl() {
  return els.instance.value.trim();
}

let filterList = [];
try { filterList = JSON.parse(localStorage.getItem("snFilterList") || "[]"); } catch {}

const COND_OP_LABELS = {
  isEmpty: "is empty", isNotEmpty: "is not empty", eq: "is", neq: "is not",
  contains: "contains", notContains: "doesn't contain", startsWith: "starts with",
  before: "before", after: "after", between: "between"
};

function conditionText(c) {
  const def = COND_FIELDS.find(x => x.field === c.field);
  const label = def ? def.label : c.field;
  const op = COND_OP_LABELS[c.oper] || c.oper;
  if (c.oper === "isEmpty" || c.oper === "isNotEmpty") return `${label} ${op}`;
  let val = String(c.value ?? "");
  if (def?.type === "choice") {
    const hit = choiceList(def.choicesKey).find(v => String(v.value) === val);
    if (hit) val = hit.label;
  }
  if (c.oper === "between") return `${label} between ${val} and ${c.value2}`;
  return `${label} ${op} ${val}`;
}

function conditionsSummary(conds) {
  let out = "";
  (conds || []).forEach((c, i) => {
    out += i > 0 ? (c.join === "OR" ? " OR " : " AND ") : "";
    out += conditionText(c);
  });
  return out;
}

function describeFilterSet(f) {
  const bits = [TABLE_LABELS[f.table] || f.table];
  const cs = conditionsSummary(f.conditions);
  if (cs) bits.push(cs);
  return bits.join(" · ");
}

function filterKey(f) {
  return JSON.stringify([f.table, f.conditions]);
}

function renderFilterList() {
  els.filterListCard.classList.toggle("hidden", !filterList.length);
  els.addFilterBtn.textContent = filterList.length ? `Add to filter list (${filterList.length})` : "+ Add to filter list";
  els.filterListBox.innerHTML = "";
  filterList.forEach((f, i) => {
    const div = document.createElement("div");
    div.className = "flitem";
    const span = document.createElement("span");
    span.textContent = describeFilterSet(f);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Remove";
    btn.textContent = "\u2715";
    btn.addEventListener("click", () => {
      filterList.splice(i, 1);
      saveFilterList();
    });
    div.append(span, btn);
    els.filterListBox.appendChild(div);
  });
}

function saveFilterList() {
  localStorage.setItem("snFilterList", JSON.stringify(filterList));
  renderFilterList();
}

$("addFilterBtn").addEventListener("click", () => {
  try {
    const f = currentFilters();
    delete f.onlyMyQueue;
    delete f.rawQuery;
    const key = filterKey(f);
    if (filterList.some(x => filterKey(x) === key)) {
      log("This exact filter set is already in the list");
      return;
    }
    filterList.push(f);
    saveFilterList();
    condRows = [];
    renderCondRows();
    refreshGenerated();
    els.filterListCard.classList.remove("flash");
    void els.filterListCard.offsetWidth;
    els.filterListCard.classList.add("flash");
    setTimeout(() => els.filterListCard.classList.remove("flash"), 1000);
    log(`Added filter ${filterList.length}: ${describeFilterSet(f)}`, "success");
  } catch (err) {
    log(err.message, "error");
  }
});

$("clearFilterListBtn").addEventListener("click", () => {
  filterList = [];
  saveFilterList();
});

renderFilterList();

function condsAllowedForTable() {
  const t = els.ticketType.value;
  return COND_FIELDS.filter(f => !f.tables || f.tables.includes(t));
}

const COND_OPS = {
  ref: [["isEmpty", "is empty"], ["isNotEmpty", "is not empty"]],
  string: [["contains", "contains"], ["notContains", "doesn't contain"], ["startsWith", "starts with"], ["eq", "is"], ["isEmpty", "is empty"], ["isNotEmpty", "is not empty"]],
  choice: [["eq", "is"], ["neq", "is not"]],
  date: [["before", "before"], ["after", "after"], ["between", "between"]]
};

let condRows = [];

function condFieldDef(key) {
  return COND_FIELDS.find(f => f.key === key);
}

function renderCondRows() {
  els.condRows.innerHTML = "";
  if (!condRows.length) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "No conditions — e.g. Assigned-to is empty OR State is In Progress";
    els.condRows.appendChild(hint);
    return;
  }
  condRows.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "crow";

    if (i > 0) {
      const joinSel = document.createElement("select");
      joinSel.className = "cjoin";
      for (const [v, lbl] of [["AND", "AND"], ["OR", "OR"]]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = lbl;
        joinSel.appendChild(o);
      }
      joinSel.value = r.join || "AND";
      joinSel.addEventListener("change", () => { r.join = joinSel.value; refreshGenerated(); });
      row.appendChild(joinSel);
    }

    const fieldSel = document.createElement("select");
    fieldSel.className = "cfield";
    for (const f of condsAllowedForTable()) {
      const o = document.createElement("option");
      o.value = f.key; o.textContent = f.label;
      fieldSel.appendChild(o);
    }
    if (![...fieldSel.options].some(o => o.value === r.field)) {
      r.field = fieldSel.options[0]?.value || "";
      r.op = (COND_OPS[condFieldDef(r.field)?.type] || [])[0]?.[0];
      r.value = ""; r.value2 = "";
    }
    fieldSel.value = r.field;
    fieldSel.addEventListener("change", () => {
      r.field = fieldSel.value;
      r.op = (COND_OPS[condFieldDef(r.field).type][0] || [])[0];
      r.value = ""; r.value2 = "";
      renderCondRows();
      refreshGenerated();
    });
    row.appendChild(fieldSel);

    const def = condFieldDef(r.field);
    const opSel = document.createElement("select");
    opSel.className = "cop";
    for (const [v, lbl] of COND_OPS[def.type] || []) {
      const o = document.createElement("option");
      o.value = v; o.textContent = lbl;
      opSel.appendChild(o);
    }
    opSel.value = r.op;
    opSel.addEventListener("change", () => { r.op = opSel.value; renderCondRows(); refreshGenerated(); });
    row.appendChild(opSel);

    const needsValue = !["isEmpty", "isNotEmpty"].includes(r.op);
    if (needsValue) {
      if (def.type === "choice") {
        const valSel = document.createElement("select");
        valSel.className = "cval";
        const list = choiceList(def.choicesKey);
        for (const c of list) {
          const o = document.createElement("option");
          o.value = String(c.value); o.textContent = c.label;
          valSel.appendChild(o);
        }
        if (!list.length) {
          const o = document.createElement("option");
          o.textContent = "(no values)";
          valSel.appendChild(o);
        }
        if (r.value) valSel.value = String(r.value);
        else if (list.length) { r.value = String(list[0].value); valSel.value = r.value; }
        valSel.addEventListener("change", () => { r.value = valSel.value; refreshGenerated(); });
        row.appendChild(valSel);
      } else {
        const inp = document.createElement("input");
        inp.className = "cval";
        inp.type = def.type === "date" ? "date" : "text";
        inp.placeholder = def.type === "date" ? "" : "value";
        inp.value = r.value || "";
        inp.addEventListener("input", () => { r.value = inp.value; refreshGenerated(); });
        row.appendChild(inp);
        if (def.type === "date" && r.op === "between") {
          const inp2 = document.createElement("input");
          inp2.className = "cval";
          inp2.type = "date";
          inp2.value = r.value2 || "";
          inp2.addEventListener("input", () => { r.value2 = inp2.value; refreshGenerated(); });
          row.appendChild(inp2);
        }
      }
    }

    const del = document.createElement("button");
    del.type = "button";
    del.className = "cdel";
    del.title = "Remove condition";
    del.textContent = "\u2715";
    del.addEventListener("click", () => {
      condRows.splice(i, 1);
      condRows.forEach((c, j) => { if (j > 0 && !c.join) c.join = "AND"; });
      renderCondRows();
      refreshGenerated();
    });
    row.appendChild(del);

    els.condRows.appendChild(row);
  });
}

els.addCondBtn.addEventListener("click", () => {
  condRows.push({ field: COND_FIELDS[0].key, op: COND_OPS.ref[0][0], value: "", value2: "", join: "AND" });
  renderCondRows();
});

renderCondRows();

function collectConditions() {
  const allowed = condsAllowedForTable();
  return condRows.map((r, i) => {
    const def = condFieldDef(r.field);
    if (!def) throw new Error(`Condition ${i + 1}: unknown column`);
    if (!allowed.includes(def)) {
      throw new Error(`Condition ${i + 1}: ${def.label} does not exist on ${TABLE_LABELS[els.ticketType.value] || els.ticketType.value}`);
    }
    const known = (COND_OPS[def.type] || []).some(([v]) => v === r.op);
    if (!known) throw new Error(`Condition ${i + 1}: pick an operator`);
    if (!["isEmpty", "isNotEmpty"].includes(r.op)) {
      if (!String(r.value || "").trim()) throw new Error(`Condition ${i + 1}: enter a value`);
      if (r.op === "between" && !String(r.value2 || "").trim()) throw new Error(`Condition ${i + 1}: enter the second date`);
    }
    return { join: i === 0 ? "AND" : (r.join || "AND"), field: def.field, oper: r.op, value: r.value || "", value2: r.value2 || "" };
  });
}

function requireInstance() {
  const url = instanceUrl();
  if (!/^https:\/\/.+/.test(url)) throw new Error("Enter a valid https instance URL");
  return url;
}

function currentFilters() {
  const missing = cfgMembers.filter(m => !m.sysId).map(m => m.name);
  if (missing.length) log(`Team members without sys_id are skipped (acknowledgement detection): ${missing.join(", ")}`, "error");
  return {
    table: els.ticketType.value,
    conditions: collectConditions(),
    rawQuery: els.rawQuery.value
  };
}

function configuredGroups() {
  if (!cfgQueues.length) throw new Error("No queues configured — open Settings and add assignment groups as \"Name | sys_id\"");
  const missing = cfgQueues.filter(q => !q.sysId);
  if (missing.length) throw new Error(`Queues without sys_id (open Settings to fix): ${missing.map(q => q.name).join(", ")}`);
  return cfgQueues;
}

function savePrefs() {
  chrome.storage.local.set({ snInstance: instanceUrl() });
}

const logLines = [];
let errCount = 0;
let logModalOpen = false;

function renderLogLine(container, { time, text, cls }) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${time}] ${text}`;
  line.style.color = cls === "error" ? "#f87171" : cls === "success" ? "#4ade80" : "";
  container.appendChild(line);
}

function log(text, cls = "") {
  els.logCard.classList.remove("hidden");
  if (cls === "error") {
    errCount++;
    els.logErrBadge.textContent = String(errCount);
    els.logErrBadge.classList.remove("hidden");
  }
  const entry = { time: new Date().toLocaleTimeString(), text, cls };
  logLines.push(entry);
  renderLogLine(els.log, entry);
  els.log.scrollTop = els.log.scrollHeight;
  if (logModalOpen) {
    renderLogLine(els.logMirror, entry);
    els.logMirror.scrollTop = els.logMirror.scrollHeight;
  }
}

function openLogModal() {
  logModalOpen = true;
  els.logMirror.innerHTML = "";
  for (const entry of logLines) renderLogLine(els.logMirror, entry);
  els.logMirror.scrollTop = els.logMirror.scrollHeight;
  els.logModal.classList.remove("hidden");
}

function closeLogModal() {
  logModalOpen = false;
  els.logModal.classList.add("hidden");
}

els.logHead.addEventListener("click", openLogModal);
els.logClose.addEventListener("click", closeLogModal);
els.logModal.addEventListener("click", e => { if (e.target === els.logModal) closeLogModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && logModalOpen) closeLogModal(); });

els.logCopy.addEventListener("click", () => {
  navigator.clipboard.writeText(logLines.map(l => `[${l.time}] ${l.text}`).join("\n"))
    .then(() => { els.logCopy.textContent = "Copied"; setTimeout(() => { els.logCopy.textContent = "Copy all"; }, 1500); })
    .catch(() => {});
});

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function connect() {
  try {
    const url = requireInstance();
    els.connect.disabled = true;
    els.connState.textContent = "Checking…";
    els.connState.classList.remove("on");
    const groups = configuredGroups();
    const members = cfgMembers.filter(m => m.sysId);
    els.connState.textContent = `Ready · ${groups.length} queue${groups.length > 1 ? "s" : ""}`;
    els.connState.classList.add("on");
    log(
      `Ready (no setup server calls): ${groups.length} queue(s), ${members.length} team member(s) from settings` +
      (cfgMembers.length > members.length ? ` · ${cfgMembers.length - members.length} member(s) missing sys_id` : ""),
      "success"
    );
    savePrefs();
    refreshGenerated();
  } catch (err) {
    els.connState.textContent = "Not ready";
    els.connState.classList.remove("on");
    log(err.message, "error");
  } finally {
    els.connect.disabled = false;
  }
}

function refreshGenerated() {
  try {
    const q = buildEncodedQuery(currentFilters());
    els.generatedQuery.textContent =
      q || `(no filters — all ${TABLE_LABELS[els.ticketType.value] || "tickets"} you can read)`;
  } catch (e) {
    els.generatedQuery.textContent = e.message;
  }
}

["change", "input"].forEach(ev => {
  [els.ticketType].forEach(el =>
    el.addEventListener(ev, () => { refreshGenerated(); })
  );
});
els.rawQuery.addEventListener("input", refreshGenerated);
els.ticketType.addEventListener("change", () => {
  renderCondRows();
  refreshGenerated();
});

els.connect.addEventListener("click", connect);
els.instance.addEventListener("change", () => {
  els.connState.textContent = "Not ready";
  els.connState.classList.remove("on");
});

function setBusy(state) {
  busy = state;
  els.preview.disabled = state;
  els.runBtn.disabled = state;
  els.progressWrap.classList.toggle("hidden", !state);
  if (state) {
    els.fill.style.width = "4%";
    els.fill.style.background = "#f59e0b";
    els.stageLabel.textContent = "Starting…";
  }
}

els.preview.addEventListener("click", async () => {
  try {
    setBusy(true);
    els.stageLabel.textContent = "Resolving group…";
    const res = await send({
      type: "COUNT",
      instanceUrl: requireInstance(),
      groups: configuredGroups(),
      filters: currentFilters()
    });
    if (res.ok) {
      els.stageLabel.textContent = `${res.total} matching tickets`;
      log(`Preview: ${res.total} tickets match`, "success");
    } else throw new Error(res.error);
  } catch (err) {
    els.stageLabel.textContent = err.message;
    log(err.message, "error");
  } finally {
    setBusy(false);
  }
});

els.runBtn.addEventListener("click", async () => {
  try {
    if (busy) return;
    setBusy(true);
    const live = currentFilters();
    const sets = filterList.length
      ? filterList.map(f => ({ ...f, rawQuery: live.rawQuery }))
      : [live];
    await send({
      type: "RUN",
      instanceUrl: requireInstance(),
      groups: configuredGroups(),
      filters: sets[0],
      filterSets: sets
    });
    log(`Run started with ${sets.length} filter set${sets.length > 1 ? "s" : ""}…`);
  } catch (err) {
    setBusy(false);
    els.stageLabel.textContent = err.message;
    log(err.message, "error");
  }
});

$("viewBtn").addEventListener("click", () => {
  els.viewBtn.classList.remove("attention");
  openViewer();
});

async function openViewer() {
  const url = chrome.runtime.getURL("viewer/viewer.html");
  try {
    const tabs = await chrome.tabs.query({ url: `${url}*` });
    if (tabs.length) {
      const tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch {}
  chrome.tabs.create({ url });
}

const STAGE_PCT = { resolve: 8, count: 15, phase1: null, phase2: null, analyze: 92 };
const STAGE_BASE = { phase1: 20, phase2: 60 };

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== "PROGRESS") return;
  const { stage, detail } = msg;

  if (stage === "diag") {
    const isProblem = /401|403|429|MISSING|RATE LIMITED/.test(detail);
    log(detail, isProblem ? "error" : "");
    return;
  }

  if (stage === "error") {
    els.fill.style.width = "100%";
    els.fill.style.background = "var(--bad)";
    els.stageLabel.textContent = detail;
    log(detail, "error");
    setBusy(false);
    return;
  }

  els.stageLabel.textContent = detail;
  if (stage !== "done") log(detail);

  let pct = STAGE_PCT[stage];
  if (pct === null) {
    const m = detail.match(/(\d+)\/(\d+)/);
    pct = m ? STAGE_BASE[stage] + (+m[1] / +m[2]) * (stage === "phase1" ? 40 : 25) : STAGE_BASE[stage];
    els.fill.style.width = Math.min(pct, STAGE_BASE[stage] + 24) + "%";
  } else if (typeof pct === "number") {
    els.fill.style.width = pct + "%";
  }

  if (stage === "done") {
    els.fill.style.width = "100%";
    els.fill.style.background = "var(--good)";
    els.stageLabel.textContent = detail;
    log(detail, "success");
    setBusy(false);
    els.viewBtn.classList.add("attention");
    chrome.storage.local.get(["lastRun"], cfg => {
      if (cfg.lastRun) {
        els.lastRun.textContent =
          `Last run: ${cfg.lastRun.tickets} tickets for "${cfg.lastRun.group}" · ${cfg.lastRun.at.slice(0, 16).replace("T", " ")}`;
      }
    });
  }
});
