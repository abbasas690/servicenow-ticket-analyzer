const SLA_TABLE = {
  1: { min: 2, max: 4 },
  2: { min: 4, max: 8 },
  3: { min: 1, max: 5 },
  4: { min: 10, max: 15 }
};

function deriveType(refNum) {
  const s = String(refNum || "");
  if (s.startsWith("INC")) return "Incident";
  if (s.startsWith("REQ")) return "RFS";
  if (s.startsWith("PTASK")) return "Problem";
  return "";
}

function slaPriority(priority) {
  let n = parseInt(String(priority));
  if (!Number.isFinite(n)) return 0;
  if (n > 4) n = 4;
  return SLA_TABLE[n] ? n : 0;
}

function metSLA(value, priority, threshold) {
  const p = slaPriority(priority);
  if (!p) return "";
  const v = parseFloat(value);
  if (isNaN(v)) return "";
  return v <= SLA_TABLE[p][threshold] ? "YES" : "NO";
}

function hmsToHours(hms) {
  if (!hms && hms !== 0) return 0;
  const parts = String(hms).split(":");
  if (parts.length < 2) return parseFloat(hms) || 0;
  return parseInt(parts[0]) + parseInt(parts[1]) / 60 + (parseInt(parts[2]) || 0) / 3600;
}

function hoursToHMS(decimalHours) {
  if (decimalHours === "" || decimalHours === "0" || isNaN(parseFloat(decimalHours))) return "";
  const totalSecs = Math.round(parseFloat(decimalHours) * 3600);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function normDate(v) {
  if (!v) return "";
  const s = String(v).trim().replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "");
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}:\d{2}(?::\d{2})?)$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]} ${m[4]}`;
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})[ ](\d{2}:\d{2}(?::\d{2})?)$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}`;
  return s;
}

function parseDate(str) {
  if (!str) return null;
  const [datePart, timePart] = String(str).trim().split(/\s+/);
  const [dd, mm, yyyy] = datePart.split("-");
  if (!yyyy || !mm || !dd) return null;
  const d = new Date(`${yyyy}-${mm}-${dd}T${timePart || "00:00:00"}`);
  return isNaN(d) ? null : d;
}

function businessHoursBetween(startStr, endStr) {
  const start = typeof startStr === "string" ? parseDate(startStr) : startStr;
  const end = typeof endStr === "string" ? parseDate(endStr) : endStr;
  if (!start || !end || isNaN(start) || isNaN(end)) return 0;

  const WORK_START_H = 8;
  const WORK_END_H = 17;

  function isWorkday(d) { const day = d.getDay(); return day !== 0 && day !== 6; }

  let hours = 0;
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  for (let d = new Date(startDay); d <= endDay; d.setDate(d.getDate() + 1)) {
    if (!isWorkday(d)) continue;
    const ws = new Date(d); ws.setHours(WORK_START_H, 0, 0, 0);
    const we = new Date(d); we.setHours(WORK_END_H, 0, 0, 0);
    const segStart = d.getTime() === startDay.getTime() ? new Date(Math.min(Math.max(start, ws), we)) : ws;
    const segEnd = d.getTime() === endDay.getTime() ? new Date(Math.min(Math.max(end, ws), we)) : we;
    if (segEnd > segStart) hours += (segEnd - segStart) / 3600000;
  }
  return hours;
}

function calcBusinessHours(createdStr, resolvedStr, suspendedStr, resumedStr, priority) {
  const p = slaPriority(priority);
  const start = parseDate(createdStr);
  if (!start) return "";

  const end = resolvedStr ? parseDate(resolvedStr) : new Date();
  if (!end) return "";

  if (p === 1 || p === 2) {
    return Math.max(0, (end - start) / 3600000).toFixed(2);
  }

  let hours = businessHoursBetween(start, end);

  if (suspendedStr && resumedStr) {
    const suspended = parseDate(suspendedStr);
    const resumed = parseDate(resumedStr);
    if (suspended && resumed) {
      hours -= businessHoursBetween(suspended, resumed);
    }
  }

  return Math.max(0, hours).toFixed(2);
}

function calcIncCurrentHours(assignedStr, resolvedStr, suspendedStr, resumedStr, priority) {
  if (!assignedStr) return "0";
  const p = slaPriority(priority);
  const start = parseDate(assignedStr);
  if (!start) return "0";

  if (p === 1 || p === 2) {
    const end = resolvedStr ? parseDate(resolvedStr) : new Date();
    if (!end) return "0";
    return Math.max(0, (end - start) / 3600000).toFixed(2);
  }

  let end;
  if (resolvedStr) {
    end = parseDate(resolvedStr);
  } else if (!suspendedStr) {
    end = new Date();
  } else if (!resumedStr) {
    end = parseDate(suspendedStr);
  } else {
    end = new Date();
  }
  if (!end) return "0";

  let hours = businessHoursBetween(start, end);

  if (suspendedStr && resumedStr) {
    const suspended = parseDate(suspendedStr);
    const resumed = parseDate(resumedStr);
    if (suspended && resumed) {
      hours -= businessHoursBetween(suspended, resumed);
    }
  }

  return Math.max(0, hours).toFixed(2);
}

function calcResponseSLA(assignedStr, acknowledgedStr, suspendedStr, resumedStr, priority) {
  if (!assignedStr) return "";
  const p = slaPriority(priority);
  const start = parseDate(assignedStr);
  if (!start) return "";
  const end = acknowledgedStr ? parseDate(acknowledgedStr) : new Date();
  if (!end) return "";

  if (p === 1 || p === 2) {
    return hoursToHMS(Math.max(0, (end - start) / 3600000));
  }

  let hours = businessHoursBetween(start, end);
  if (suspendedStr && resumedStr) {
    const suspended = parseDate(suspendedStr);
    const resumed = parseDate(resumedStr);
    if (suspended && resumed) {
      const resumedCapped = new Date(Math.min(resumed.getTime(), end.getTime()));
      hours -= businessHoursBetween(suspended, resumedCapped);
    }
  }
  return hoursToHMS(Math.max(0, hours));
}

function calcTotalAgeDays(businessHoursDecimal) {
  const h = parseFloat(businessHoursDecimal);
  if (isNaN(h)) return "";
  return (h / 9).toFixed(2);
}

function analysedDateString(now = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()}`;
}

function buildReport(row, fmt, now = new Date()) {
  const keyInputs = [
    row.number, row.priority, row.state, row.assignmentGroup,
    row.createdOn, row.assignTime, row.acknTime, row.resolvedAt,
    row.suspendTime, row.resumeTime
  ].join("|");
  if (row.__reportKey === keyInputs && row.__report) return row.__report;

  const type = deriveType(row.number);
  const created = normDate(row.createdOn);
  const assigned = normDate(fmt ? fmt(row.assignTime) : row.assignTime);
  const ackn = normDate(fmt ? fmt(row.acknTime) : row.acknTime);
  const resolved = normDate(fmt ? fmt(row.resolvedAt) : row.resolvedAt);
  const susp = normDate(fmt ? fmt(row.suspendTime) : row.suspendTime);
  const resumed = normDate(fmt ? fmt(row.resumeTime) : row.resumeTime);

  const incidentHours = calcBusinessHours(created, resolved, susp, resumed, row.priority);
  const incidentTotalAge = calcTotalAgeDays(incidentHours);
  const incCurrentHours = calcIncCurrentHours(assigned, resolved, susp, resumed, row.priority);
  const incidentCurrentAge = calcTotalAgeDays(incCurrentHours);
  const responseSLA = calcResponseSLA(assigned, ackn, susp, resumed, row.priority);
  const respVal = responseSLA === "" ? NaN : hmsToHours(responseSLA);
  const metResponse = isNaN(respVal) ? "" : metSLA(respVal, row.priority, "max");
  const incVal = parseFloat(incidentHours);
  const metMin = isNaN(incVal) ? "" : metSLA(incVal, row.priority, "min");
  const metMax = isNaN(incVal) ? "" : metSLA(incVal, row.priority, "max");

  const rep = {
    type,
    opCo: "BA",
    domain: "AO",
    created, assigned, ackn, resolved, susp, resumed,
    impactedApplication: row.configItem || "",
    resolutionType: row.solutionType || "",
    rootCauseCategory: row.rootCause || "",
    incidentHours,
    incidentTotalAge,
    incCurrentHours,
    incidentCurrentAge,
    responseSLA,
    cumulativeSla: incCurrentHours,
    cumulativeDays: incidentCurrentAge,
    timeTaken: incidentCurrentAge,
    metResponseSLA: metResponse,
    metMinResolutionSLA: metMin,
    metMaxResolutionSLA: metMax,
    analysedDate: analysedDateString(now)
  };

  row.__reportKey = keyInputs;
  row.__report = rep;
  return rep;
}

(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : null).Report =
  { SLA_TABLE, deriveType, slaPriority, metSLA, hmsToHours, hoursToHMS, normDate, parseDate, businessHoursBetween, calcBusinessHours, calcIncCurrentHours, calcResponseSLA, calcTotalAgeDays, analysedDateString, buildReport };
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SLA_TABLE, deriveType, slaPriority, metSLA, hmsToHours, hoursToHMS, normDate, parseDate, businessHoursBetween, calcBusinessHours, calcIncCurrentHours, calcResponseSLA, calcTotalAgeDays, analysedDateString, buildReport };
}
