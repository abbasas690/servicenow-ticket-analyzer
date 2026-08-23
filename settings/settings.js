const $ = id => document.getElementById(id);

const DEFAULTS = {
  version: 2,
  instanceUrl: "",
  defaults: {
    ticketType: "incident",
    queues: [],
    teamMembers: []
  },
  params: {
    auditBatchSize: 80,
    tablePageSize: 1000,
    timelineSource: "auto",
    debugResponses: false
  }
};

const TICKET_TYPES = ["incident", "change_request", "problem", "sc_req_item", "sc_task"];
const TIMELINE_SOURCES = ["auto", "history", "activity"];

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function parsePairLine(line) {
  const m = String(line).split(/\s*[|=]\s*/);
  if (m.length >= 2 && m[0] && m[1]) return { name: m[0].trim(), sysId: m.slice(1).join(" ").trim() };
  const name = String(line).trim();
  return name ? { name, sysId: "" } : null;
}

function parsePairs(text) {
  return String(text).split("\n").map(s => s.trim()).filter(Boolean).map(parsePairLine).filter(Boolean);
}

function formatPairs(arr) {
  return (arr || []).map(p =>
    typeof p === "string" ? p : `${p.name || ""}${p.sysId ? ` | ${p.sysId}` : ""}`
  ).filter(Boolean).join("\n");
}

function collect() {
  return {
    version: 2,
    instanceUrl: $("instanceUrl").value.trim().replace(/\/+$/, ""),
    defaults: {
      ticketType: TICKET_TYPES.includes($("ticketType").value) ? $("ticketType").value : "incident",
      queues: parsePairs($("queues").value),
      teamMembers: parsePairs($("teamMembers").value)
    },
    params: {
      auditBatchSize: clampInt($("auditBatchSize").value, 10, 200, DEFAULTS.params.auditBatchSize),
      tablePageSize: clampInt($("tablePageSize").value, 100, 5000, DEFAULTS.params.tablePageSize),
      timelineSource: TIMELINE_SOURCES.includes($("timelineSource").value) ? $("timelineSource").value : "auto",
      debugResponses: !!$("debugResponses").checked
    }
  };
}

function fill(s) {
  const merged = structuredClone(DEFAULTS);
  if (s && typeof s === "object") {
    if (typeof s.instanceUrl === "string") merged.instanceUrl = s.instanceUrl;
    if (s.defaults && typeof s.defaults === "object") {
      Object.assign(merged.defaults, s.defaults);
      if (!Array.isArray(merged.defaults.queues) || !merged.defaults.queues.length) {
        if (typeof s.defaults.queueName === "string" && s.defaults.queueName) {
          merged.defaults.queues = [{ name: s.defaults.queueName, sysId: "" }];
        }
      }
    }
    if (s.params && typeof s.params === "object") Object.assign(merged.params, s.params);
  }
  $("instanceUrl").value = merged.instanceUrl;
  $("ticketType").value = TICKET_TYPES.includes(merged.defaults.ticketType) ? merged.defaults.ticketType : "incident";
  $("queues").value = formatPairs(merged.defaults.queues);
  $("teamMembers").value = formatPairs(merged.defaults.teamMembers);
  $("auditBatchSize").value = merged.params.auditBatchSize;
  $("tablePageSize").value = merged.params.tablePageSize;
  if (!TIMELINE_SOURCES.includes(merged.params.timelineSource)) merged.params.timelineSource = "auto";
  $("timelineSource").value = merged.params.timelineSource;
  $("debugResponses").checked = !!merged.params.debugResponses;
}

function missingSysIds(s) {
  const all = [...(s.defaults?.queues || []), ...(s.defaults?.teamMembers || [])];
  return all.filter(p => typeof p === "object" && !p.sysId).map(p => p.name);
}

function mergeResolved(text, resolved) {
  const map = new Map((resolved || []).map(r => [String(r.name).toLowerCase(), r.sysId]));
  return parsePairs(text).map(p =>
    !p.sysId && map.has(p.name.toLowerCase())
      ? { name: p.name, sysId: map.get(p.name.toLowerCase()) }
      : p
  );
}

function setCardStatus(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.style.color = isError ? "#f87171" : "#4ade80";
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 6000);
}

async function resolveIds(kind, textareaId, statusId) {
  const instanceUrl = $("instanceUrl").value.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(instanceUrl)) throw new Error("Save a valid https:// instance URL first");
  const pairs = parsePairs($(textareaId).value);
  const need = pairs.filter(p => !p.sysId).map(p => p.name);
  if (!need.length) { setCardStatus(statusId, "No entries are missing a sys_id"); return; }
  setCardStatus(statusId, `Resolving ${need.length} name${need.length > 1 ? "s" : ""}…`);
  const res = await chrome.runtime.sendMessage({ type: "RESOLVE_IDS", kind, instanceUrl, names: need });
  if (!res?.ok) throw new Error(res?.error || "Resolution failed — is a ServiceNow tab open?");
  const updated = mergeResolved($(textareaId).value, res.resolved);
  $(textareaId).value = formatPairs(updated);
  const stillMissing = updated.filter(p => !p.sysId).length;
  setCardStatus(
    statusId,
    stillMissing ? `${res.resolved.length} resolved, ${stillMissing} not found` : `Resolved all ${res.resolved.length}`,
    stillMissing > 0
  );
}

$("resolveQueuesBtn").addEventListener("click", () =>
  resolveIds("groups", "queues", "queuesStatus").catch(e => setCardStatus("queuesStatus", e.message, true)));
$("resolveMembersBtn").addEventListener("click", () =>
  resolveIds("users", "teamMembers", "membersStatus").catch(e => setCardStatus("membersStatus", e.message, true)));

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.style.color = isError ? "#f87171" : "#4ade80";
  setTimeout(() => { el.textContent = ""; }, 3500);
}

async function save() {
  const settings = collect();
  await chrome.storage.local.set({ pluginSettings: settings });
  const missing = missingSysIds(settings);
  setStatus(missing.length ? `Saved — ${missing.length} entr${missing.length > 1 ? "ies" : "y"} missing sys_id` : "Saved", missing.length > 0);
}

$("saveBtn").addEventListener("click", () => save().catch(e => setStatus(e.message, true)));

$("resetBtn").addEventListener("click", async () => {
  fill(null);
  await chrome.storage.local.set({ pluginSettings: collect() });
  setStatus("Reset to defaults");
});

chrome.storage.local.get(["pluginSettings"], ({ pluginSettings }) => fill(pluginSettings));
