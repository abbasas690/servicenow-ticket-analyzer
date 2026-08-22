const $ = id => document.getElementById(id);

const DEFAULTS = {
  version: 1,
  instanceUrl: "",
  defaults: {
    ticketType: "incident",
    queues: [],
    teamMembers: []
  },
  params: {
    auditBatchSize: 80,
    tablePageSize: 1000
  }
};

const TICKET_TYPES = ["incident", "change_request", "problem", "sc_req_item", "sc_task"];

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function collect() {
  const lines = id => $(id).value.split("\n").map(s => s.trim()).filter(Boolean);
  return {
    version: 1,
    instanceUrl: $("instanceUrl").value.trim().replace(/\/+$/, ""),
    defaults: {
      ticketType: TICKET_TYPES.includes($("ticketType").value) ? $("ticketType").value : "incident",
      queues: lines("queues"),
      teamMembers: lines("teamMembers")
    },
    params: {
      auditBatchSize: clampInt($("auditBatchSize").value, 10, 200, DEFAULTS.params.auditBatchSize),
      tablePageSize: clampInt($("tablePageSize").value, 100, 5000, DEFAULTS.params.tablePageSize)
    }
  };
}

function fill(s) {
  const merged = structuredClone(DEFAULTS);
  if (s && typeof s === "object") {
    if (typeof s.instanceUrl === "string") merged.instanceUrl = s.instanceUrl;
    if (s.defaults && typeof s.defaults === "object") {
      Object.assign(merged.defaults, s.defaults);
      if (Array.isArray(s.defaults.teamMembers)) merged.defaults.teamMembers = s.defaults.teamMembers;
      if (!Array.isArray(merged.defaults.queues) || !merged.defaults.queues.length) {
        if (typeof s.defaults.queueName === "string" && s.defaults.queueName) {
          merged.defaults.queues = [s.defaults.queueName];
        }
      } else if (Array.isArray(merged.defaults.queues)) {
        merged.defaults.queues = merged.defaults.queues.filter(q => typeof q === "string");
      }
    }
    if (s.params && typeof s.params === "object") Object.assign(merged.params, s.params);
  }
  $("instanceUrl").value = merged.instanceUrl;
  $("ticketType").value = TICKET_TYPES.includes(merged.defaults.ticketType) ? merged.defaults.ticketType : "incident";
  $("queues").value = (merged.defaults.queues || []).join("\n");
  $("teamMembers").value = (merged.defaults.teamMembers || []).join("\n");
  $("auditBatchSize").value = merged.params.auditBatchSize;
  $("tablePageSize").value = merged.params.tablePageSize;
}

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.style.color = isError ? "#f87171" : "#4ade80";
  setTimeout(() => { el.textContent = ""; }, 3500);
}

async function save() {
  await chrome.storage.local.set({ pluginSettings: collect() });
  setStatus("Saved");
}

$("saveBtn").addEventListener("click", () => save().catch(e => setStatus(e.message, true)));

$("resetBtn").addEventListener("click", async () => {
  fill(null);
  await chrome.storage.local.set({ pluginSettings: collect() });
  setStatus("Reset to defaults");
});

chrome.storage.local.get(["pluginSettings"], ({ pluginSettings }) => fill(pluginSettings));
