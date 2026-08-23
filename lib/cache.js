const QUERY_TTL_MS = 15 * 60 * 1000;
const TIMELINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function queryKey(table, encodedQuery) {
  const s = `${table}\n${encodedQuery}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b);
  }
  return ("0000000" + (h1 >>> 0).toString(16)).slice(-8) + "-" +
         ("0000000" + (h2 >>> 0).toString(16)).slice(-8);
}

function isFreshQuery(entry, now = Date.now()) {
  return !!entry
    && typeof entry.at === "number"
    && Array.isArray(entry.records)
    && (now - entry.at) < QUERY_TTL_MS;
}

function timelineNeedsFetch(cachedEntry, ticketUpdatedOn) {
  if (!cachedEntry || !Array.isArray(cachedEntry.events)) return true;
  if (!ticketUpdatedOn) return false;
  const cachedAt = String(cachedEntry.updatedAt || "");
  return String(ticketUpdatedOn) > cachedAt;
}

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("snAnalyzerCache", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("queries");
        db.createObjectStore("timelines");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
  }
  return dbPromise;
}

function idbReq(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
  }));
}

async function getQuery(table, encodedQuery) {
  const key = queryKey(table, encodedQuery);
  return idbReq("queries", "readonly", s => s.get(key));
}

async function putQuery(table, encodedQuery, records) {
  const key = queryKey(table, encodedQuery);
  await idbReq("queries", "readwrite", s => s.put({ at: Date.now(), table, query: encodedQuery, records }, key));
  purgeExpired().catch(() => {});
}

async function getTimelines(table, sysIds) {
  const hits = new Map();
  for (const sysId of sysIds) {
    try {
      const entry = await idbReq("timelines", "readonly", s => s.get(`${table}:${sysId}`));
      if (entry) hits.set(sysId, entry);
    } catch {}
  }
  return hits;
}

async function putTimelines(table, entries) {
  for (const e of entries) {
    await idbReq("timelines", "readwrite",
      s => s.put({ updatedAt: e.updatedAt || "", at: Date.now(), events: e.events || [] }, `${table}:${e.sysId}`));
  }
  purgeExpired().catch(() => {});
}

async function purgeExpired(now = Date.now()) {
  const cutoffQ = now - QUERY_TTL_MS;
  const cutoffT = now - TIMELINE_TTL_MS;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction(["queries", "timelines"], "readwrite");
    const q = t.objectStore("queries").openCursor();
    q.onsuccess = () => {
      const c = q.result;
      if (!c) return;
      if (!(c.value?.at >= cutoffQ)) c.delete();
      c.continue();
    };
    const tl = t.objectStore("timelines").openCursor();
    tl.onsuccess = () => {
      const c = tl.result;
      if (!c) return;
      if (!(c.value?.at >= cutoffT)) c.delete();
      c.continue();
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

async function clearAll() {
  dbPromise = null;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open("snAnalyzerCache", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const t = db.transaction(["queries", "timelines"], "readwrite");
    t.objectStore("queries").clear();
    t.objectStore("timelines").clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  db.close();
}

(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : null).SnCache =
  { QUERY_TTL_MS, TIMELINE_TTL_MS, queryKey, isFreshQuery, timelineNeedsFetch, getQuery, putQuery, getTimelines, putTimelines, purgeExpired, clearAll };
if (typeof module !== "undefined" && module.exports) {
  module.exports = { QUERY_TTL_MS, TIMELINE_TTL_MS, queryKey, isFreshQuery, timelineNeedsFetch, getQuery, putQuery, getTimelines, putTimelines, purgeExpired, clearAll };
}
