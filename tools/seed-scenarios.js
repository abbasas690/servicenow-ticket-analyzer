#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");

const args = process.argv.slice(2);
const CLEAN = args.includes("--clean");
const QUEUES_FILE = args.find(a => /^--queues-file=.+/.test(a))?.split("=").slice(1).join("=");
const MEMBERS_FILE = args.find(a => /^--members-file=.+/.test(a))?.split("=").slice(1).join("=");
const DELAY = Math.max(200, parseInt(args.find(a => /^--delay=\d+$/.test(a))?.split("=")[1] || "1400", 10));
const INSTANCE = (args.find(a => a.startsWith("http")) || process.env.SEED_INSTANCE || "").replace(/\/+$/, "");
const ADMIN_FALLBACK = process.env.SEED_ADMIN_USER || "admin";

const MARKER = "[SCEN";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function question(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); });
  });
}

function parsePairs(text) {
  return String(text).split("\n").map(l => {
    const m = l.split(/\s*[|=]\s*/);
    if (m.length >= 2 && m[0] && m[1]) return { name: m[0].trim(), sysId: m.slice(1).join(" ").trim() };
    return null;
  }).filter(Boolean);
}

async function loadList(flagFile, label) {
  if (flagFile) return parsePairs(fs.readFileSync(flagFile, "utf8"));
  console.log(`\nPaste ${label} (one per line, "Name | sys_id"). Empty line to finish:`);
  const lines = [];
  while (true) {
    const line = await question("> ");
    if (!line) break;
    lines.push(line);
  }
  return parsePairs(lines.join("\n"));
}

async function main() {
  let instanceUrl = INSTANCE;
  if (!instanceUrl) instanceUrl = await question("Instance URL (https://devXXXXX.service-now.com): ");
  if (!/^https:\/\/.+/.test(instanceUrl)) { console.error("Invalid instance URL"); process.exit(1); }
  const user = process.env.SEED_USER || await question("Username: ");
  const pass = process.env.SEED_PASS || await question("Password: ");
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  async function api(method, path, params, body) {
    const url = new URL(instanceUrl + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      method,
      headers: { "Authorization": auth, "Accept": "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return json.result !== undefined ? json.result : json;
  }

  try {
    const queues = await loadList(QUEUES_FILE, "configured QUEUES");
    if (!queues.length) throw new Error("No queues provided");
    const members = await loadList(MEMBERS_FILE, "configured TEAM MEMBERS");
    console.log(`\nQueues: ${queues.map(q => q.name).join(", ")}`);
    console.log(`Members: ${members.map(m => m.name).join(", ")}`);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const marker = `[SCEN ${stamp}]`;

    const grmemberCache = new Map();
    async function ensureMember(queueSysId, userSysId, queueName, userName) {
      const key = `${queueSysId}:${userSysId}`;
      if (grmemberCache.has(key)) return;
      const existing = await api("GET", "/api/now/table/sys_user_grmember", {
        sysparm_query: `group=${queueSysId}^user=${userSysId}`,
        sysparm_limit: 1,
        sysparm_fields: "sys_id"
      });
      if (!existing.length) {
        await api("POST", "/api/now/table/sys_user_grmember", {}, { group: queueSysId, user: userSysId });
        console.log(`    [roster] added ${userName} to ${queueName}`);
      }
      grmemberCache.set(key, true);
    }

    async function findAdmin() {
      const rows = await api("GET", "/api/now/table/sys_user", {
        sysparm_query: `user_name=${ADMIN_FALLBACK}`,
        sysparm_limit: 1,
        sysparm_fields: "sys_id,name"
      });
      if (!rows.length) throw new Error(`Fallback non-member user "${ADMIN_FALLBACK}" not found`);
      return { name: rows[0].name, sysId: rows[0].sys_id };
    }

    if (CLEAN) {
      await clean(api, MARKER);
      return;
    }
    await clean(api, MARKER);

    const admin = await findAdmin();
    const Q = name => { const q = queues.find(x => x.name === name); if (!q) throw new Error(`Queue "${name}" not in provided list`); return q.sysId; };
    let mi = 0;
    const nextMember = () => members[mi++ % members.length];

    const SCENARIOS = [
      { id: "S01", desc: "happy-path ack+hold+resume", queue: "SN QA Queue Alpha",
        steps: ["born", "member", "hold", "progress", "resolve"] },
      { id: "S02", desc: "direct-resolve fallback", queue: "SN QA Queue Alpha",
        steps: ["born", "member", "resolve"] },
      { id: "S03", desc: "prequeue-ackn must stay null", queue: "SN QA Queue Alpha", bornQueue: "Network",
        steps: ["born", "member", "enter"] },
      { id: "S04", desc: "prequeue-hold must stay null", queue: "SN QA Queue Alpha", bornQueue: "Hardware",
        steps: ["born", "hold-out", "enter-held", "resolve"] },
      { id: "S05", desc: "reentry takes latest entry", queue: "SN QA Queue Alpha", bornQueue: "Network",
        steps: ["born", "enter", "leave", "re-enter", "member"] },
      { id: "S06", desc: "never-acked (admin only)", queue: "SN QA Queue Beta",
        steps: ["born", "admin", "hold", "progress", "resolve"] },
      { id: "S07", desc: "outside-hold not counted", queue: "SN QA Queue Alpha", bornQueue: "Service Desk",
        steps: ["born", "enter", "leave", "hold-out", "progress-out", "re-enter", "resolve"] },
      { id: "S08", desc: "full lifecycle to Closed", queue: "SN QA Queue Beta",
        steps: ["born", "member", "hold", "progress", "resolve", "close"] },
      { id: "S09", desc: "two members, ackn = last", queue: "SN QA Queue Alpha",
        steps: ["born", "member", "member2", "progress"] },
      { id: "S10", desc: "double hold, first wins", queue: "Network",
        steps: ["born", "member", "hold", "progress", "hold2", "progress2", "resolve"] },
      { id: "S11", desc: "ackn survives reassign away", queue: "Hardware",
        steps: ["born", "member", "admin", "resolve"] },
      { id: "S12", desc: "hold straight to resolve", queue: "Database",
        steps: ["born", "member", "hold", "resolve-from-hold"] },
      { id: "S13", desc: "no assignee at all", queue: "Openspace",
        steps: ["born", "progress", "resolve"] },
      { id: "S14", desc: "late member after progress", queue: "Service Desk",
        steps: ["born", "admin", "progress", "member-late", "hold", "progress2", "resolve"] },
      { id: "S15", desc: "left-and-closed elsewhere", queue: "SN QA Queue Beta",
        steps: ["born", "member", "leave", "close-out"] }
    ];

    const created = [];
    for (const s of SCENARIOS) {
      const qSys = Q(s.queue);
      const m1 = nextMember();
      const m2 = nextMember();
      console.log(`\n${s.id} ${s.desc} (${s.queue})`);
      const payload = {
        short_description: `${marker} ${s.id} ${s.desc}`,
        description: `Scenario seed: ${s.desc}`
      };
      if (!s.bornQueue) payload.assignment_group = qSys;
      else payload.assignment_group = Q(s.bornQueue);
      const rec = await api("POST", "/api/now/table/incident", {}, payload);
      const sysId = rec.sys_id;
      const number = rec.number?.display_value || rec.number;
      created.push({ number, ...s, m1, m2 });

      for (let si = 0; si < s.steps.length; si++) {
        const step = s.steps[si];
        await sleep(DELAY);
        const patch = {};
        let logLine = "";
        switch (true) {
          case step === "enter" || step === "re-enter" || step === "enter-held":
            patch.assignment_group = qSys; logLine = `group -> ${s.queue}`; break;
          case step === "leave":
            patch.assignment_group = Q(s.bornQueue || "Network"); logLine = `group -> ${patch.assignment_group === qSys ? "(same!)" : s.bornQueue}`; break;
          case step === "member":
          case step === "member-late":
            await ensureMember(qSys, m1.sysId, s.queue, m1.name);
            patch.assigned_to = m1.sysId; logLine = `assigned_to ${m1.name}`; break;
          case step === "member2":
            await ensureMember(qSys, m2.sysId, s.queue, m2.name);
            patch.assigned_to = m2.sysId; logLine = `assigned_to ${m2.name}`; break;
          case step === "admin":
            patch.assigned_to = admin.sysId; logLine = `assigned_to ${admin.name}`; break;
          case step.startsWith("hold"):
            patch.state = "3"; logLine = "state On Hold"; break;
          case step === "resolve" || step === "resolve-from-hold":
          case step === "close" || step === "close-out":
            patch.state = step === "close" || step === "close-out" ? "7" : "6";
            patch.close_code = "Solution provided"; patch.close_notes = "scenario seed";
            logLine = `state ${step.startsWith("close") ? "Closed" : "Resolved"}`; break;
          case step.startsWith("progress"):
            patch.state = "2"; logLine = "state In Progress"; break;
          case step === "born":
            continue;
          default:
            throw new Error(`Unknown step ${step}`);
        }
        if (step === "enter-held") patch.assignment_group = qSys;
        if (step === "progress-out") patch.assigned_to = "";
        try {
          await api("PATCH", `/api/now/table/incident/${sysId}`, {}, patch);
          console.log(`    -> ${logLine}${patch.assignment_group && step !== "enter" && !step.includes("held") ? "" : ""}`);
        } catch (err) {
          console.log(`    step ${step} failed: ${err.message.slice(0, 160)}`);
        }
      }
    }

    console.log("\n===== EXPECTED TIMELINES (instance clock) =====");
    for (const c of created) {
      console.log(`${c.number}  ${c.id} ${c.desc}`);
    }
    console.log(`
Verify in the viewer after a pull:
  S01 assign=opened ackn=S01-member hold>prog resume=prog-time
  S02 assign=opened ackn set resume=resolved-time (direct fallback)
  S03 ackn MUST BE EMPTY (assignment predates queue entry)
  S04 suspend MUST BE EMPTY (hold happened before entry)
  S05 assign = re-entry time (latest), ackn set after re-entry
  S06 ackn EMPTY (only admin assigned)
  S07 suspend/resume EMPTY (hold was outside queue)
  S08 full chain + closedAt populated
  S09 ackn = SECOND member's time
  S10 suspend = FIRST hold, onHoldCount=2
  S11 ackn = member time even though admin assigned afterwards
  S12 resume = resolve time coming straight off Hold
  S13 ackn EMPTY, assign=opened, no ackn ever
  S14 ackn = late member time (post-entry), suspend after it
  S15 assign=opened, ackn=member, closedAt set (closed outside queue)
Marker for cleanup: short_description STARTSWITH [SCEN`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

async function clean(api, prefix) {
  let deleted = 0;
  const rows = await api("GET", "/api/now/table/incident", {
    sysparm_query: `short_descriptionSTARTSWITH${prefix}`,
    sysparm_limit: 500,
    sysparm_fields: "sys_id,number"
  });
  for (const row of rows) {
    await api("DELETE", `/api/now/table/incident/${row.sys_id}`);
    deleted++;
  }
  console.log(deleted ? `Deleted ${deleted} previous scenario tickets` : "No previous scenario tickets found");
}

main();
