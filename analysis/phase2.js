function parseUtc(s) {
  if (!s) return NaN;
  const str = String(s).trim().replace(" ", "T");
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(str) ? str : str + "Z");
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

  let currentGroup = null;
  const hasGroupEvent = events.some(e => e.field === "assignment_group");
  if (!hasGroupEvent && ctx.snapshotGroupId && ctx.snapshotGroupId === ctx.queueSysId) {
    const bornAt = parseUtc(ctx.openedAt);
    if (Number.isFinite(bornAt)) {
      result.assignTime = new Date(bornAt).toISOString();
      result.lastQueueEntryAt = bornAt;
      currentGroup = ctx.queueSysId;
    }
  }

  for (const e of events) {
    if (e.field === "assignment_group") {
      const enteringQueue = e.newValue === ctx.queueSysId;
      if (enteringQueue) {
        result.assignTime = new Date(e.at).toISOString();
        result.lastQueueEntryAt = e.at;
        currentGroup = ctx.queueSysId;
      } else {
        currentGroup = e.newValue;
      }
      continue;
    }

    if (e.field === "assigned_to" && result.lastQueueEntryAt !== null) {
      if (ctx.memberIds.includes(e.newValue) && e.at >= result.lastQueueEntryAt) {
        result.acknTime = new Date(e.at).toISOString();
      }
      continue;
    }

    if (e.field === "state" && currentGroup === ctx.queueSysId) {
      const toLabel = ctx.stateMap[e.newValue] || "";
      const fromLabel = ctx.stateMap[e.oldValue] || "";
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

function analyzeAll(records, auditByTicket, stateMap, queueCtx, legacyMemberIds) {
  let membersByQueue, fallbackMembers;
  if (queueCtx && typeof queueCtx === "object" && !Array.isArray(queueCtx)) {
    membersByQueue = queueCtx.membersByQueue || {};
    fallbackMembers = queueCtx.fallbackMembers || [];
  } else {
    membersByQueue = { [queueCtx || ""]: legacyMemberIds || [] };
    fallbackMembers = legacyMemberIds || [];
  }
  const out = [];
  let missingAudit = 0;
  for (const rec of records) {
    const snapshotGroupId = rawValue(rec.assignment_group);
    const sysId = typeof rec.sys_id === "object"
      ? (rec.sys_id.value || rec.sys_id.display_value)
      : rec.sys_id;
    const rows = auditByTicket[sysId];
    if (!rows) missingAudit++;
    const t = extractTimelines(rows, {
      stateMap,
      queueSysId: snapshotGroupId,
      memberIds: membersByQueue[snapshotGroupId] || fallbackMembers,
      snapshotGroupId,
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

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

function normalizeAuditRefs(byTicket, refPairs) {
  const map = new Map();
  for (const p of refPairs || []) {
    if (p && p.name && p.sysId) map.set(String(p.name).trim().toLowerCase(), String(p.sysId).trim());
  }
  const norm = v => {
    const s = v === null || v === undefined ? "" : String(v?.value ?? v).trim();
    if (!s || SYS_ID_RE.test(s)) return s;
    return map.get(s.toLowerCase()) || s;
  };
  for (const events of Object.values(byTicket || {})) {
    for (const e of events) {
      if (e.field === "assignment_group" || e.field === "assigned_to") {
        e.oldValue = norm(e.oldValue);
        e.newValue = norm(e.newValue);
      }
    }
  }
  return byTicket;
}

if (typeof self !== "undefined") self.Analysis = { extractTimelines, analyzeAll, normalizeAuditRefs };
if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractTimelines, analyzeAll, normalizeAuditRefs };
}
