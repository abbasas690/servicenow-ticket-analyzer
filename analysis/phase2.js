function parseUtc(s) {
  if (!s) return NaN;
  const str = String(s).trim().replace(" ", "T");
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(str) ? str : str + "Z");
}

function nameKey(v) {
  return String(v ?? "").trim().toLowerCase();
}

function extractTimelines(auditRows, ctx) {
  const events = (auditRows || [])
    .map(r => ({
      field: r.field,
      oldValue: r.oldValue || "",
      newValue: r.newValue || "",
      at: parseUtc(r.at)
    }))
    .filter(e => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);

  const result = {
    assignTime: null,
    acknTime: null,
    suspendTime: null,
    resumeTime: null,
    resumeSource: null,
    onHoldCount: 0,
    lastQueueEntryAt: null
  };

  const memberSet = new Set((ctx.memberNames || []).map(nameKey));
  const inQueue = g => g != null && nameKey(g) === nameKey(ctx.queueName);

  let currentGroup = null;
  const hasGroupEvent = events.some(e => e.field === "assignment_group");
  if (!hasGroupEvent && inQueue(ctx.snapshotGroupName)) {
    const bornAt = parseUtc(ctx.openedAt);
    if (Number.isFinite(bornAt)) {
      result.assignTime = new Date(bornAt).toISOString();
      result.lastQueueEntryAt = bornAt;
      currentGroup = ctx.snapshotGroupName;
    }
  }

  for (const e of events) {
    if (e.field === "assignment_group") {
      if (inQueue(e.newValue)) {
        result.assignTime = new Date(e.at).toISOString();
        result.lastQueueEntryAt = e.at;
        currentGroup = e.newValue;
      } else {
        currentGroup = e.newValue;
      }
      continue;
    }

    if (e.field === "assigned_to" && result.lastQueueEntryAt !== null) {
      if (memberSet.has(nameKey(e.newValue)) && e.at >= result.lastQueueEntryAt) {
        result.acknTime = new Date(e.at).toISOString();
      }
      continue;
    }

    if (e.field === "state" && inQueue(currentGroup)) {
      const lbl = v => ctx.stateMap[String(v ?? "").trim()] || String(v ?? "").trim();
      const toLabel = lbl(e.newValue);
      const fromLabel = lbl(e.oldValue);
      const isOnHold = toLabel.toLowerCase() === "on hold";
      const wasOnHold = fromLabel.toLowerCase() === "on hold";

      if (isOnHold && !wasOnHold) {
        result.onHoldCount++;
        if (!result.suspendTime) {
          result.suspendTime = new Date(e.at).toISOString();
          result._suspendEpoch = e.at;
        }
      }

      if (wasOnHold && !result.resumeTime && result._suspendEpoch && e.at >= result._suspendEpoch) {
        if (toLabel.toLowerCase() === "in progress") {
          result.resumeTime = new Date(e.at).toISOString();
          result.resumeSource = "In Progress";
        } else if (toLabel.toLowerCase() === "resolved") {
          result.resumeTime = new Date(e.at).toISOString();
          result.resumeSource = "Resolved";
        }
      }
    }
  }

  delete result._suspendEpoch;
  const bornAt = parseUtc(ctx.openedAt);
  if (Number.isFinite(bornAt)) {
    const a = parseUtc(result.assignTime);
    if (Number.isFinite(a) && a < bornAt) {
      result.assignTime = new Date(bornAt).toISOString();
    }
  }
  return result;
}

function fieldValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return v.display_value || v.value || "";
}

function rawValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return v.value || "";
}

function analyzeAll(records, auditByTicket, stateMap, queueCtx) {
  const membersByQueue = (queueCtx && queueCtx.membersByQueue) || {};
  const fallbackMembers = (queueCtx && queueCtx.fallbackMembers) || [];
  const out = [];
  let missingAudit = 0;
  for (const rec of records) {
    const snapshotGroupName = fieldValue(rec.assignment_group);
    const sysId = typeof rec.sys_id === "object"
      ? (rec.sys_id.value || rec.sys_id.display_value)
      : rec.sys_id;
    const rows = auditByTicket[sysId];
    if (!rows) missingAudit++;
    const t = extractTimelines(rows, {
      stateMap,
      queueName: nameKey(snapshotGroupName),
      memberNames: membersByQueue[nameKey(snapshotGroupName)] || fallbackMembers,
      snapshotGroupName,
      openedAt: rawValue(rec.opened_at)
    });
    out.push({
      sysId,
      number: fieldValue(rec.number),
      shortDescription: fieldValue(rec.short_description),
      state: fieldValue(rec.state),
      stateValue: rawValue(rec.state),
      priority: fieldValue(rec.priority),
      priorityValue: rawValue(rec.priority),
      category: fieldValue(rec.category),
      caller: fieldValue(rec.caller_id),
      assignmentGroup: fieldValue(rec.assignment_group),
      assignedTo: fieldValue(rec.assigned_to),
      assignedToSysId: rawValue(rec.assigned_to),
      updatedOn: fieldValue(rec.sys_updated_on),
      updatedBy: fieldValue(rec.sys_updated_by),
      configItem: fieldValue(rec.cmdb_ci),
      createdOn: fieldValue(rec.sys_created_on),
      incidentState: fieldValue(rec.incident_state),
      resolvedAt: fieldValue(rec.resolved_at),
      resolvedAtRaw: rawValue(rec.resolved_at),
      openedAt: fieldValue(rec.opened_at),
      openedAtRaw: rawValue(rec.opened_at),
      closedAt: fieldValue(rec.closed_at),
      closedAtRaw: rawValue(rec.closed_at),
      assignTime: t.assignTime || "",
      acknTime: t.acknTime || "",
      suspendTime: t.suspendTime || "",
      resumeTime: t.resumeTime || "",
      resumeSource: t.resumeSource || "",
      onHoldCount: t.onHoldCount
    });
  }
  return { rows: out, missingAudit };
}

const ACTIVITY_ANCHORS = [
  { field: "assignment_group", labels: ["assignment group"] },
  { field: "assigned_to", labels: ["assigned to"] },
  { field: "state", labels: ["state", "incident state"] }
];

function pmHour(h, ap) {
  if (/p/i.test(ap || "") && h < 12) return h + 12;
  if (/a/i.test(ap || "") && h === 12) return 0;
  return h;
}

function parseSnDisplayMs(s) {
  const str = String(s || "").trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
  if (!m) {
    m = str.match(/^(\d{1,2})[-.](\d{1,2})[-.](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], pmHour(+m[4], m[7]), +m[5], +(m[6] || 0));
    m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
    if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], pmHour(+m[4], m[7]), +m[5], +(m[6] || 0));
    const p = Date.parse(str);
    return Number.isFinite(p) ? p : NaN;
  }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], pmHour(+m[4], m[7]), +m[5], +(m[6] || 0));
}

const ACTIVITY_DT_RE = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}\/\d{1,2}\/\d{4})[ T](\d{1,2}:\d{2}(?::\d{2})?)\s*([AaPp][Mm])?/g;

function scanSnDateTime(text) {
  const re = new RegExp(ACTIVITY_DT_RE.source, "g");
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const ms = parseSnDisplayMs(`${m[1]} ${m[2]}${m[3] ? " " + m[3] : ""}`);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return "";
}

function cleanCapture(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\\+/g, "")
    .replace(/^["'\s]+|["'\s,.;]+$/g, "")
    .trim();
}

function extractEventsFromActivity(entries) {
  const out = [];
  const seen = new Set();
  for (const entry of entries || []) {
    if (!entry || typeof entry !== "object") continue;

    const changes = Array.isArray(entry.changes) ? entry.changes : null;
    if (changes) {
      for (const ch of changes) {
        if (!ch || typeof ch !== "object") continue;
        const label = String(ch.label ?? ch.field_label ?? "").toLowerCase();
        const anchor = ACTIVITY_ANCHORS.find(a => a.labels.some(l => label === l));
        if (!anchor) continue;
        const at = scanSnDateTime(JSON.stringify(ch)) ||
          scanSnDateTime(JSON.stringify(entry));
        const ev = {
          field: anchor.field,
          oldValue: cleanCapture(ch.old_value ?? ch.old ?? ch.from ?? ""),
          newValue: cleanCapture(ch.new_value ?? ch.new ?? ch.to ?? ""),
          at
        };
        const key = `${ev.field}|${ev.oldValue}|${ev.newValue}|${ev.at}`;
        if (ev.at && !seen.has(key)) {
          seen.add(key);
          out.push(ev);
        }
      }
      continue;
    }

    const text = JSON.stringify(entry);
    if (!text) continue;
    const low = text.toLowerCase();
    for (const anchor of ACTIVITY_ANCHORS) {
      for (const label of anchor.labels) {
        const idx = low.indexOf(label);
        if (idx === -1) continue;
        const window = text.slice(idx, idx + 200);
        let m = window.match(new RegExp(
          label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "[^a-z]{0,3}changed from (.+?) to (.+?)(?=\\s+on\\s+[\\d<\"]|<|,|\\}|$)",
          "i"
        ));
        if (!m) continue;
        const at = scanSnDateTime(window);
        if (!at) break;
        const ev = {
          field: anchor.field,
          oldValue: cleanCapture(m[1]),
          newValue: cleanCapture(m[2]),
          at
        };
        const key = `${ev.field}|${ev.oldValue}|${ev.newValue}|${ev.at}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(ev);
        }
        break;
      }
    }
  }
  return out;
}

function extractEventsFromListHistory(payload) {
  const byTicket = {};
  for (const entry of payload?.entries || []) {
    if (!entry || typeof entry !== "object") continue;
    const docId = String(entry.document_id || "").trim();
    if (!docId) continue;
    const at = String(entry.sys_created_on || "").trim();
    if (!at) continue;
    for (const ch of entry.entries?.changes || []) {
      if (!ch || typeof ch !== "object") continue;
      let fname = String(ch.field_name || "").trim();
      if (!fname) continue;
      if (fname === "incident_state") fname = "state";
      (byTicket[docId] ||= []).push({
        field: fname,
        oldValue: String(ch.old_value ?? ch.sanitized_old_value ?? ""),
        newValue: String(ch.new_value ?? ch.sanitized_new_value ?? ""),
        at
      });
    }
  }
  return byTicket;
}

const G = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : null;
if (G) G.Analysis = { extractTimelines, analyzeAll, extractEventsFromActivity, extractEventsFromListHistory };
if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractTimelines, analyzeAll, extractEventsFromActivity, extractEventsFromListHistory };
}
