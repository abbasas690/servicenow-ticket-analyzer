importScripts(
  "lib/servicenow.js",
  "lib/querybuilder.js",
  "lib/statechoices.js",
  "analysis/phase2.js"
);

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

const TABLE_LABELS = {
  incident: "Incident",
  change_request: "Change Request",
  problem: "Problem",
  sc_req_item: "Requested Item",
  sc_task: "Catalog Task"
};

const DEFAULT_FIELDS = [
  "sys_id", "number", "state", "priority",
  "assignment_group", "assigned_to", "opened_at", "closed_at",
  "short_description", "caller_id", "category",
  "sys_updated_on", "sys_updated_by", "cmdb_ci",
  "sys_created_on", "incident_state", "resolved_at"
];

let running = false;
let tokenCache = null;
const TOKEN_TTL_MS = 8 * 60 * 1000;

async function resolveToken(origin, tab, forceFresh = false) {
  if (!forceFresh && tokenCache && Date.now() - tokenCache.at < TOKEN_TTL_MS) {
    return tokenCache;
  }
  let token = await getCookieToken(origin);
  let source = token ? "cookie" : null;
  if (!token && tab?.id !== undefined) {
    token = await getPageToken(tab.id);
    source = token ? "page-injection" : null;
  }
  if (token) tokenCache = { value: token, source, at: Date.now() };
  return { value: token, source };
}

async function findServiceNowTab(origin) {
  try {
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });
    return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
  } catch {
    return null;
  }
}

function getCookieToken(origin) {
  return new Promise(resolve => {
    try {
      chrome.cookies.get({ url: origin, name: "g_ck" }, c => resolve(c?.value || null));
    } catch {
      resolve(null);
    }
  });
}

async function getPageToken(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => (typeof g_ck === "string" && g_ck ? g_ck : window.g_ck || null)
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function smartFetch(url, opts = {}) {
  const attempt = opts.attempt || 0;
  const origin = new URL(url).origin;
  const tab = await findServiceNowTab(origin);

  if (!tab) {
    return {
      ok: false,
      error: `No open tab found for ${origin}. Open your ServiceNow instance in a browser tab, log in, and keep it open while using the analyzer.`
    };
  }

  const { value: token, source } = await resolveToken(origin, tab, attempt > 0);

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "SN_FETCH", url, token });
    if (resp && resp.ok) {
      if (resp.status === 401 && attempt < 2) {
        tokenCache = null;
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        return smartFetch(url, { ...opts, attempt: attempt + 1 });
      }
      return {
        ok: true,
        status: resp.status,
        text: resp.text,
        headers: resp.headers,
        via: "relay",
        hadToken: Boolean(resp.tokenFound),
        tokenSource: source
      };
    }
  } catch {}

  const headers = { "Accept": "application/json" };
  if (token) headers["X-UserToken"] = token;

  try {
    const res = await fetch(url, { method: "GET", credentials: "include", headers });
    const text = await res.text();
    const responseHeaders = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });

    if (res.status === 401 && token && attempt < 2) {
      tokenCache = null;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      return smartFetch(url, { attempt: attempt + 1 });
    }
    return { ok: true, status: res.status, text, headers: responseHeaders, via: "direct", hadToken: Boolean(token), tokenSource: source };
  } catch (err) {
    return { ok: false, error: String(err), via: "direct", hadToken: Boolean(token) };
  }
}

function diagError(type, err) {
  try { progress("diag", `${type} failed: ${err.message}`); } catch {}
}

function makeClient(instanceUrl) {  const client = new ServiceNowClient(instanceUrl, {
    transport: smartFetch,
    onDiagnostic: d => {
      const ms = typeof d.ms === "number" ? ` · ${d.ms}ms` : "";
      if (d.kind === "warn") {
        if (d.note) {
          progress("diag", `${d.path || "audit"} ⚠ ${d.note}`);
          return;
        }
        if (d.rateLimited) {
          progress("diag", `⚠ RATE LIMITED — ServiceNow is throttling requests; auto-retrying (${d.attempt}/${4}). If this repeats, reduce tickets per run or ask your admin about rate-limit rules.`);
          return;
        }
        const why = d.netError ? `network: ${d.netError}` : `server ${d.status}`;
        progress("diag", `${d.path} ✕ ${why} · retrying (${d.attempt}/${4})${ms} · q=${d.query || ""}`);
        return;
      }
      if (d.kind === "err") {
        progress("diag", `${d.path} → HTTP ${d.status}${ms}${d.retriesExhausted ? " · retries exhausted" : ""} · q=${d.query || ""}`);
        return;
      }
      const token = d.hadToken === null || d.hadToken === undefined
        ? ""
        : ` · token=${d.hadToken ? d.tokenSource || "sent" : "MISSING"}`;
      const rows = d.bodyRows !== undefined && d.bodyRows !== null ? ` · result=${d.bodyRows}` : "";
      const preview = d.bodyPreview ? ` · body=${d.bodyPreview}` : "";
      progress("diag", `${d.path} → ${d.status}${ms} · via=${d.via}${token}${rows} · q=${d.query || ""}${preview}`);
    }
  });
  const clamp = (v, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };
  return chrome.storage.local.get("pluginSettings").then(({ pluginSettings: s }) => {
    if (s?.params) {
      client.auditBatchSize = clamp(s.params.auditBatchSize, 10, 200) || client.auditBatchSize;
      client.pageSize = clamp(s.params.tablePageSize, 100, 5000) || client.pageSize;
      client.debugResponses = !!s.params.debugResponses;
      const src = s.params.timelineSource;
      if (src === "history" || src === "activity") client.timelineSource = src;
      else client.timelineSource = "auto";
    }
    return client;
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PING") {
    sendResponse({ ok: true, running });
    return false;
  }
  if (msg.type === "COUNT") {
    handleCount(msg).then(sendResponse).catch(err => { diagError("COUNT", err); sendResponse({ ok: false, error: err.message }); });
    return true;
  }
  if (msg.type === "RUN") {
    runPull(msg);
    sendResponse({ ok: true, started: true });
    return true;
  }
  if (msg.type === "RESOLVE_IDS") {
    handleResolveIds(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

async function handleResolveIds(msg) {
  const instanceUrl = String(msg.instanceUrl || "").trim();
  if (!/^https:\/\//i.test(instanceUrl)) throw new Error("Enter a valid https:// instance URL first");
  const names = (Array.isArray(msg.names) ? msg.names : []).map(n => String(n || "").trim()).filter(Boolean);
  if (!names.length) return { ok: true, resolved: [] };
  const client = await makeClient(instanceUrl);
  let resolved;
  if (msg.kind === "groups") {
    resolved = (await client.resolveGroups(names)).map(g => ({ name: g.name, sysId: g.sys_id }));
  } else if (msg.kind === "users") {
    resolved = await client.resolveUserNames(names);
  } else {
    throw new Error(`Unknown resolve kind: ${msg.kind}`);
  }
  return { ok: true, resolved };
}

function scopeGroups(msg) {
  const groups = (Array.isArray(msg.groups) ? msg.groups : [])
    .filter(g => g && g.name && g.sysId);
  if (!groups.length) {
    throw new Error("No queues configured with a sys_id — open Settings and add each queue as \"Name | sys_id\"");
  }
  return groups;
}

function groupScopeOf(groups) {
  return groups.length === 1
    ? { groupSysId: groups[0].sysId }
    : { groupSysIds: groups.map(g => g.sysId) };
}

async function handleCount(msg) {
  const table = msg.filters?.table || "incident";
  const client = await makeClient(msg.instanceUrl);
  const groups = scopeGroups(msg);
  const { memberSysIds: _drop, ...filters } = msg.filters || {};
  const encodedQuery = buildEncodedQuery({ ...filters, ...groupScopeOf(groups) });
  const total = await client.count(table, encodedQuery);
  return { ok: true, total, encodedQuery };
}

function progress(stage, detail) {
  chrome.runtime.sendMessage({ type: "PROGRESS", stage, detail }).catch(() => {});
}

async function runPull(msg) {
  if (running) return;
  running = true;
  const abort = new AbortController();
  try {
    const sets = Array.isArray(msg.filterSets) && msg.filterSets.length
      ? msg.filterSets
      : [msg.filters || {}];
    const client = await makeClient(msg.instanceUrl);

    const groups = scopeGroups(msg);
    progress("resolve", `Queues (from settings): ${groups.map(g => g.name).join(", ")}`);
    const groupScope = groupScopeOf(groups);

    const settings = (await chrome.storage.local.get(["pluginSettings"])).pluginSettings;
    const teamIds = [...new Set(
      ((settings?.defaults?.teamMembers || []))
        .map(m => (m && typeof m === "object" ? m.sysId : ""))
        .filter(Boolean)
    )];
    if (!teamIds.length) {
      progress("resolve", "No team members with sys_id — acknowledgement dates will stay empty");
    } else {
      progress("resolve", `${teamIds.length} team member(s) configured for acknowledgement detection`);
    }
    const membersByQueue = Object.fromEntries(groups.map(g => [g.sysId, teamIds]));

    const byTable = new Map();
    const runEntries = [];
    for (let i = 0; i < sets.length; i++) {
      const set = sets[i];
      const table = set.table || "incident";
      const label = `Filter ${i + 1}/${sets.length}`;
      const { memberSysIds: _drop, ...rest } = set;
      const encodedQuery = buildEncodedQuery({ ...rest, ...groupScope });

      progress("count", `${label}: counting...`);
      const total = await client.count(table, encodedQuery);
      progress("count", `${label}: ${total} tickets matched`);
      if (total === 0) {
        runEntries.push({ table, query: encodedQuery, pulled: 0 });
        continue;
      }

      progress("phase1", `${label}: pulling ${total} tickets...`);
      const records = await client.fetchAllRecords(
        table, encodedQuery, msg.fields || DEFAULT_FIELDS,
        p => {
          progress("phase1", `${label}: phase1 ${p.fetched}/${total} tickets`);
        },
        abort.signal
      );
      if (!byTable.has(table)) byTable.set(table, new Map());
      const bucket = byTable.get(table);
      let fresh = 0;
      for (const r of records) {
        const id = r.sys_id?.value || r.sys_id;
        if (id && !bucket.has(id)) { bucket.set(id, r); fresh++; }
      }
      runEntries.push({ table, query: encodedQuery, pulled: records.length, new: fresh });
    }

    let allRows = [];
    let missingAuditTotal = 0;
    const auditCounts = {};
    const sampleAuditRows = [];
    let sampleRecord = null;
    for (const [table, bucket] of byTable) {
      const records = [...bucket.values()];
      if (!records.length) continue;
      const tLabel = TABLE_LABELS[table] || table;
      const sysIds = records.map(r => r.sys_id?.value || r.sys_id).filter(Boolean);

      progress("phase2", `Phase 2 (${tLabel}): audit for ${sysIds.length} tickets...`);
      const auditByTicket = await client.fetchAudit(
        sysIds,
        ["assignment_group", "assigned_to", "state"],
        p => progress("phase2", p.ticketsTotal != null
          ? `Phase 2 (${tLabel}): audit ticket ${p.ticketsDone}/${p.ticketsTotal}`
          : `Phase 2 (${tLabel}): batch ${p.batchesDone}/${p.batchesTotal}`),
        abort.signal,
        table
      );
      Analysis.normalizeAuditRefs(auditByTicket, [
        ...(settings?.defaults?.queues || []),
        ...(settings?.defaults?.teamMembers || []),
        ...groups
      ]);
      auditCounts[table] = Object.keys(auditByTicket).length;
      if (!sampleRecord) sampleRecord = records[0];
      if (!sampleAuditRows.length) {
        sampleAuditRows.push(...Object.entries(auditByTicket).slice(0, 3)
          .map(([k, v]) => ({ sysId: k.slice(0, 8), rows: v.length })));
      }

      progress("analyze", `Applying timeline rules (${tLabel})...`);
      const { rows, missingAudit } = analyzeAll(records, auditByTicket, snStateMap(table), { membersByQueue, fallbackMembers: teamIds });
      allRows.push(...rows);
      missingAuditTotal += missingAudit;
    }
    const rows = allRows;
    const missingAudit = missingAuditTotal;
    if (!rows.length) throw new Error("No tickets match this filter list");

    const prev = (await chrome.storage.local.get(["lastData"])).lastData;
    const merged = mergeRows(prev?.rows || [], rows);
    const at = new Date().toISOString();
    const group = groups.map(g => g.name).join(", ");
    const runs = [...(prev?.runs || []), ...runEntries.map(e => ({
      at,
      table: e.table,
      group,
      query: e.query,
      pulled: e.pulled
    }))];

    await chrome.storage.local.set({
      lastData: {
        at: new Date().toISOString(),
        instance: msg.instanceUrl,
        missingAudit: (prev?.missingAudit || 0) + missingAudit,
        totalPulled: merged.length,
        debug: {
          sampleRecord,
          ticketsWithAudit: Object.values(auditCounts).reduce((a, b) => a + b, 0),
          auditCountsByTable: auditCounts,
          sampleAuditRowCounts: sampleAuditRows,
          sampleTimelines: rows.filter(r => r.assignTime || r.acknTime || r.suspendTime || r.resumeTime).slice(0, 3)
            .map(r => ({ number: r.number, assign: r.assignTime, ackn: r.acknTime, suspend: r.suspendTime, resume: r.resumeTime }))
        },
        runs,
        rows: merged
      }
    });

    await chrome.storage.local.set({
      lastRun: {
        at: new Date().toISOString(),
        instance: msg.instanceUrl,
        query: runEntries.map(e => `[${TABLE_LABELS[e.table] || e.table}] ${e.query}`).join(" | "),
        group: groups.map(g => g.name).join(", "),
        tickets: rows.length
      }
    });

    chrome.runtime.sendMessage({ type: "DATA_UPDATED" }).catch(() => {});

    progress("done",
      `Run complete: ${rows.length} pulled · ${merged.length} total in view` +
      (missingAudit ? ` · ${missingAudit} had no audit data` : ""));
  } catch (err) {
    progress("error", err.message);
  } finally {
    running = false;
  }
}

function mergeRows(oldRows, newRows) {
  const byKey = new Map();
  for (const r of oldRows) byKey.set(r.sysId || r.number, r);
  for (const r of newRows) byKey.set(r.sysId || r.number, r);
  return [...byKey.values()];
}
