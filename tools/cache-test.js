#!/usr/bin/env node
const { QUERY_TTL_MS, queryKey, isFreshQuery, timelineNeedsFetch } = require("../lib/cache.js");

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

console.log("== queryKey ==");
const k1 = queryKey("incident", "assignment_group.nameINQA^state!=7");
check("stable", queryKey("incident", "assignment_group.nameINQA^state!=7"), k1);
check("differs by table", queryKey("problem", "assignment_group.nameINQA^state!=7") !== k1, true);
check("differs by query", queryKey("incident", "assignment_group.nameINQA^state=2") !== k1, true);
check("16 hex chars", /^[0-9a-f]{8}-[0-9a-f]{8}$/.test(k1), true);
const keys = new Set(Array.from({ length: 2000 }, (_, i) => queryKey("incident", `x=${i}`)));
check("no collisions in 2000", keys.size, 2000);

console.log("== isFreshQuery ==");
const now = Date.now();
check("null entry", isFreshQuery(null), false);
check("fresh", isFreshQuery({ at: now - 1000, records: [1] }, now), true);
check("at TTL edge", isFreshQuery({ at: now - QUERY_TTL_MS, records: [1] }, now), false);
check("expired", isFreshQuery({ at: now - QUERY_TTL_MS - 1, records: [1] }, now), false);
check("missing records array", isFreshQuery({ at: now }, now), false);
check("default ttl 15 min", QUERY_TTL_MS, 15 * 60 * 1000);

console.log("== timelineNeedsFetch ==");
check("no cache", timelineNeedsFetch(null, "2026-01-01"), true);
check("cache trusted when ticket unchanged",
  timelineNeedsFetch({ updatedAt: "2026-01-02", events: [] }, "2026-01-02"), false);
check("refetch when ticket newer",
  timelineNeedsFetch({ updatedAt: "2026-01-02", events: [] }, "2026-01-03"), true);
check("no updatedOn on ticket trusts cache",
  timelineNeedsFetch({ updatedAt: "", events: [] }, ""), false);
check("cache missing events array refetches",
  timelineNeedsFetch({ updatedAt: "2026-01-02" }, "2026-01-01"), true);
check("empty cached events still a valid hit",
  timelineNeedsFetch({ updatedAt: "2026-05-01", events: [] }, "2026-05-01"), false);

console.log(`\ncache: ${failed ? failed + " FAILED" : "all passed"}`);
process.exit(failed ? 1 : 0);
