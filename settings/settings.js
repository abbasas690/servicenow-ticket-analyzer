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
    tablePageSize: 1000,
    debugResponses: false
  },
  ai: {
    modelId: ""
  }
};

const TICKET_TYPES = ["incident", "change_request", "problem", "sc_req_item", "sc_task"];

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function parseNameLines(text) {
  const seen = new Set();
  return String(text).split("\n")
    .map(s => s.replace(/\s*[|=]\s*.*$/, "").trim())
    .filter(Boolean)
    .filter(n => (seen.has(n.toLowerCase()) ? false : (seen.add(n.toLowerCase()), true)));
}

function formatNames(arr) {
  return (arr || []).map(p => (typeof p === "string" ? p : p?.name || "")).filter(Boolean).join("\n");
}

function collect() {
  return {
    version: 2,
    instanceUrl: $("instanceUrl").value.trim().replace(/\/+$/, ""),
    defaults: {
      ticketType: TICKET_TYPES.includes($("ticketType").value) ? $("ticketType").value : "incident",
      queues: parseNameLines($("queues").value),
      teamMembers: parseNameLines($("teamMembers").value)
    },
    params: {
      tablePageSize: clampInt($("tablePageSize").value, 100, 5000, DEFAULTS.params.tablePageSize),
      debugResponses: !!$("debugResponses").checked
    },
    ai: {
      modelId: $("aiModel").value
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
          merged.defaults.queues = [s.defaults.queueName];
        }
      }
    }
    if (s.params && typeof s.params === "object") Object.assign(merged.params, s.params);
    if (s.ai && typeof s.ai === "object") Object.assign(merged.ai, s.ai);
  }
  $("instanceUrl").value = merged.instanceUrl;
  $("ticketType").value = TICKET_TYPES.includes(merged.defaults.ticketType) ? merged.defaults.ticketType : "incident";
  $("queues").value = formatNames(merged.defaults.queues);
  $("teamMembers").value = formatNames(merged.defaults.teamMembers);
  $("tablePageSize").value = merged.params.tablePageSize;
  $("debugResponses").checked = !!merged.params.debugResponses;
  if ([...$("aiModel").options].some(o => o.value === merged.ai.modelId)) {
    $("aiModel").value = merged.ai.modelId;
  }
}

function setCardStatus(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.style.color = isError ? "#f87171" : "#4ade80";
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 6000);
}

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.style.color = isError ? "#f87171" : "#4ade80";
  setTimeout(() => { el.textContent = ""; }, 3500);
}

async function save() {
  const settings = collect();
  await chrome.storage.local.set({ pluginSettings: settings });
  const q = settings.defaults.queues.length;
  const m = settings.defaults.teamMembers.length;
  setStatus(`Saved — ${q} queue${q === 1 ? "" : "s"}, ${m} member${m === 1 ? "" : "s"}`);
}

$("saveBtn").addEventListener("click", () => save().catch(e => setStatus(e.message, true)));

$("resetBtn").addEventListener("click", async () => {
  fill(null);
  await chrome.storage.local.set({ pluginSettings: collect() });
  setStatus("Reset to defaults");
});

for (const m of AiExtract.AI_MODELS) {
  const opt = document.createElement("option");
  opt.value = m.id;
  opt.textContent = m.label;
  $("aiModel").appendChild(opt);
}

let aiDownloading = false;

$("aiDownloadBtn").addEventListener("click", async () => {
  if (aiDownloading) return;
  const modelId = $("aiModel").value;
  if (!modelId) { setCardStatus("aiStatus", "Pick a model first", true); return; }
  aiDownloading = true;
  const el = $("aiStatus");
  try {
    el.style.color = "#b9c2d4";
    el.textContent = "Loading runtime…";
    const T = await import("../lib/vendor/transformers.min.js");
    T.env.backends.onnx.wasm.numThreads = 1;
    let lastFile = "";
    await T.pipeline("text-generation", modelId, {
      dtype: "q4f16",
      progress_callback: p => {
        if (p.status === "progress" && p.file) {
          if (p.file !== lastFile) { lastFile = p.file; }
          el.textContent = `${p.file} ${Math.round(p.progress || 0)}%`;
        }
      }
    });
    el.style.color = "#4ade80";
    el.textContent = "Model ready (cached for offline use)";
    await chrome.storage.local.set({ pluginSettings: collect() });
    setStatus(`Saved — AI model ${modelId.split("/")[1] || modelId}`);
  } catch (err) {
    el.style.color = "#f87171";
    el.textContent = `Download failed: ${err.message}`;
  } finally {
    aiDownloading = false;
  }
});

chrome.storage.local.get(["pluginSettings"], ({ pluginSettings }) => fill(pluginSettings));
