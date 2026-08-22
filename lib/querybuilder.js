function sanitizeValue(v) {
  return String(v ?? "").replace(/['\\]/g, "");
}

function encodeCondition(c) {
  const f = c.field;
  switch (c.oper) {
    case "isEmpty": return `${f}ISEMPTY`;
    case "isNotEmpty": return `${f}ISNOTEMPTY`;
    case "eq": return `${f}=${sanitizeValue(c.value)}`;
    case "neq": return `${f}!=${sanitizeValue(c.value)}`;
    case "contains": return `${f}LIKE${sanitizeValue(c.value)}`;
    case "notContains": return `${f}NOT LIKE${sanitizeValue(c.value)}`;
    case "startsWith": return `${f}STARTSWITH${sanitizeValue(c.value)}`;
    case "before":
      return `${f}<=javascript:gs.dateGenerate('${sanitizeValue(c.value)}','00:00:00')`;
    case "after":
      return `${f}>=javascript:gs.dateGenerate('${sanitizeValue(c.value)}','23:59:59')`;
    case "between":
      return `${f}BETWEENjavascript:gs.dateGenerate('${sanitizeValue(c.value)}','00:00:00')` +
        `@javascript:gs.dateGenerate('${sanitizeValue(c.value2)}','23:59:59')`;
    default: return "";
  }
}

function encodeConditions(list) {
  let out = "";
  (list || []).forEach((c, i) => {
    const body = encodeCondition(c);
    if (!body) return;
    out += i === 0 ? body : (c.join === "OR" ? "^OR" : "^") + body;
  });
  return out;
}

function buildEncodedQuery(cfg) {
  const parts = [];
  const dateField = cfg.dateField || "opened_at";

  if (cfg.conditions?.length) {
    const frag = encodeConditions(cfg.conditions);
    if (frag) parts.push(frag);
  }

  if (cfg.from && cfg.to) {
    parts.push(
      `${dateField}BETWEENjavascript:gs.dateGenerate('${cfg.from}','00:00:00')` +
      `@javascript:gs.dateGenerate('${cfg.to}','23:59:59')`
    );
  } else if (cfg.from) {
    parts.push(`${dateField}>=javascript:gs.dateGenerate('${cfg.from}','00:00:00')`);
  } else if (cfg.to) {
    parts.push(`${dateField}<=javascript:gs.dateGenerate('${cfg.to}','23:59:59')`);
  }

  if (cfg.states?.length) {
    const vals = cfg.states.filter(v => v !== "" && v !== null).map(String);
    if (vals.length) parts.push(`stateIN${vals.join(",")}`);
  }

  if (cfg.priorities?.length) {
    const vals = cfg.priorities.filter(v => v !== "" && v !== null).map(String);
    if (vals.length) parts.push(`priorityIN${vals.join(",")}`);
  }

  if (cfg.memberSysIds?.length) {
    const vals = cfg.memberSysIds.filter(v => v !== "" && v !== null).map(String);
    if (vals.length) parts.push(`assigned_toIN${vals.join(",")}`);
  }

  if (cfg.onlyMyQueue) {
    if (Array.isArray(cfg.groupSysIds) && cfg.groupSysIds.length) {
      parts.push(`assignment_groupIN${cfg.groupSysIds.join(",")}`);
    } else if (cfg.groupSysId) {
      parts.push(`assignment_group=${cfg.groupSysId}`);
    }
  }

  const raw = (cfg.rawQuery || "").trim();
  if (raw) parts.push(raw);

  return parts.join("^");
}

if (typeof self !== "undefined") self.QueryBuilder = { buildEncodedQuery, encodeConditions };
if (typeof module !== "undefined") module.exports = { buildEncodedQuery, encodeConditions };
