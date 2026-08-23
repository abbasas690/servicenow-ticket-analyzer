#!/usr/bin/env node
const readline = require("readline");

const TYPES = ["incident", "change_request", "problem", "sc_req_item", "sc_task"];

const args = process.argv.slice(2);
const COUNT = Math.max(1, parseInt(args.find(a => /^--count=\d+$/.test(a))?.split("=")[1] || "2", 10));
const CLEAN = args.includes("--clean");
const MEMBERS_FILE = args.find(a => /^--members-file=.+/.test(a))?.split("=").slice(1).join("=");
const INSTANCE = (args.find(a => a.startsWith("http")) || process.env.SEED_INSTANCE || "").replace(/\/+$/, "");
const STEP_DELAY_MS = 1600;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = require("fs");

function parsePairLine(line) {
  const m = String(line).split(/\s*[|=]\s*/);
  if (m.length >= 2 && m[0] && m[1]) return { name: m[0].trim(), sysId: m.slice(1).join(" ").trim() };
  return null;
}

async function loadMembers() {
  let text = "";
  if (MEMBERS_FILE) {
    text = fs.readFileSync(MEMBERS_FILE, "utf8");
  } else {
    console.log("\nPaste configured team members (one per line, \"Name | sys_id\" — same text as the plugin settings page).");
    console.log("Finish with an empty line:");
    const lines = [];
    while (true) {
      const line = await question("> ");
      if (!line) break;
      lines.push(line);
    }
    text = lines.join("\n");
  }
  const members = String(text).split("\n").map(parsePairLine).filter(Boolean);
  if (!members.length) return [];
  console.log(`Using ${members.length} configured member(s): ${members.map(m => m.name).join(", ")}`);
  return members;
}

function question(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  let instanceUrl = INSTANCE;
  if (!instanceUrl) instanceUrl = await question("Instance URL (https://devXXXXX.service-now.com): ");
  if (!/^https:\/\/.+/.test(instanceUrl)) {
    console.error("Invalid instance URL");
    process.exit(1);
  }

  let user = process.env.SEED_USER;
  let pass = process.env.SEED_PASS;
  if (!user) user = await question("Username: ");
  if (!pass) pass = await question("Password: ");

  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  async function api(method, path, params, body) {
    const url = new URL(instanceUrl + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), {
      method,
      headers: {
        "Authorization": auth,
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return json.result !== undefined ? json.result : json;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const marker = `[SEED ${stamp}]`;

  try {
    const groups = await api("GET", "/api/now/table/sys_user_group", {
      sysparm_query: "active=true",
      sysparm_limit: 50,
      sysparm_fields: "sys_id,name"
    });
    console.log("\nAvailable groups:");
    groups.forEach((g, i) => console.log(`  ${i + 1}. ${g.name}`));
    const groupName = await question("\nTarget assignment group name (exact): ");
    const group = groups.find(g => g.name === groupName);
    if (!group) throw new Error(`Group "${groupName}" not found in list above`);
    console.log(`Using group: ${group.name} (${group.sys_id})`);

    if (CLEAN) {
      await clean(api, TYPES, marker);
      return;
    }
    await clean(api, TYPES, "[SEED");
    console.log("");

    const members = await loadMembers();
    if (!members.length) {
      console.log("No configured members given — falling back to the group's first sys_user_grmember roster entry (acknowledgement dates will NOT match your plugin team list).");
    }

    const results = [];
    for (const table of TYPES) {
      try {
        const created = await seedType(api, table, group.sys_id, COUNT, marker, members);
        results.push({ table, ok: true, created });
      } catch (err) {
        results.push({ table, ok: false, error: err.message });
      }
    }

    console.log("\n===== SUMMARY =====");
    for (const r of results) {
      if (r.ok) {
        console.log(`${r.table}: ${r.created.length} seeded -> ${r.created.join(", ")}`);
      } else {
        console.log(`${r.table}: FAILED - ${r.error}`);
      }
    }
    console.log(`\nMarker for cleanup: short_description STARTSWITH [SEED`);
    console.log("Now open the extension panel, connect, and Run to pull these with timelines.");
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

async function fetchStateChoices(api, table) {
  const q = async name => api("GET", "/api/now/table/sys_choice", {
    sysparm_query: `name=${name}^element=state^inactive=false`,
    sysparm_limit: 100,
    sysparm_fields: "value,label"
  });
  let choices = await q(table);
  if (choices.length === 0 && table !== "task") {
    choices = await q("task");
  }
  return choices;
}

const TABLE_PLAN_CAPS = { change_request: ["-4"] };

async function seedType(api, table, groupSysId, count, marker, members) {
  const choices = await fetchStateChoices(api, table);
  const findLabel = pred => choices.find(c => pred(c.label.toLowerCase()));

  const holdC = findLabel(l => l.includes("on hold") || l === "pending") ||
                findLabel(l => l.includes("hold") || l.includes("pending") || l.includes("waiting"));
  const progC = findLabel(l => l.includes("in progress")) ||
                findLabel(l => l === "open" || l === "accepted" || l === "implement");
  const resC = findLabel(l => l.startsWith("resolved"));
  const closedC = findLabel(l => l.startsWith("closed"));

  let plan = [
    holdC && { label: holdC.label, value: holdC.value },
    progC && { label: progC.label, value: progC.value },
    resC && { label: resC.label, value: resC.value },
    closedC && !resC && { label: closedC.label, value: closedC.value }
  ].filter(Boolean);

  const cap = TABLE_PLAN_CAPS[table];
  if (cap) {
    plan = plan.filter(p => cap.includes(p.value));
    for (const v of cap) {
      const c = choices.find(x => x.value === v);
      if (c && !plan.some(p => p.value === v)) plan.push({ label: c.label, value: c.value });
    }
    plan.sort((a, b) => cap.indexOf(a.value) - cap.indexOf(b.value));
  }

  const needsCloseFields = table === "incident";

  console.log(`\n${table}: creating ${count}, transitions planned: ${plan.map(p => p.label).join(" -> ") || "(none)"}`);

  const created = [];
  for (let i = 0; i < count; i++) {
    const bornInQueue = i % 2 === 0;
    const payload = {
      short_description: `${marker} timeline-test ${table} #${i + 1}`,
      description: "Seeded by tools/seed-data.js for audit-timeline testing."
    };
    if (bornInQueue) payload.assignment_group = groupSysId;
    if (table === "change_request") {
      payload.type = "normal";
      payload.risk = "moderate";
    }
    let rec;
    try {
      rec = await api("POST", `/api/now/table/${table}`, {}, payload);
    } catch (err) {
      console.log(`  create #${i + 1} failed: ${err.message.slice(0, 160)}`);
      continue;
    }
    const sysId = rec.sys_id;
    const number = rec.number?.display_value || rec.number;
    created.push(number);
    console.log(`  created ${number}${bornInQueue ? " (group at creation)" : " (group via change event)"}`);

    await sleep(STEP_DELAY_MS);
    try {
      if (!bornInQueue) {
        await api("PATCH", `/api/now/table/${table}/${sysId}`, {}, { assignment_group: groupSysId });
        console.log(`    -> assignment_group set`);
        await sleep(STEP_DELAY_MS);
      }
      let assignee = null;
      if (members.length) {
        assignee = members[i % members.length].sysId;
      } else {
        try {
          assignee = await firstGroupMember(api, groupSysId);
        } catch (err) {
          console.log(`    roster fallback failed: ${err.message.slice(0, 120)}`);
        }
      }
      if (assignee) {
        await api("PATCH", `/api/now/table/${table}/${sysId}`, {}, { assigned_to: assignee });
        const who = members.length ? members[i % members.length].name : assignee;
        console.log(`    -> assigned_to ${who}`);
      } else {
        console.log(`    -> no assignee available, skipped`);
      }
    } catch (err) {
      console.log(`    assign failed: ${err.message.slice(0, 120)}`);
    }

    for (const step of plan) {
      await sleep(STEP_DELAY_MS);
      try {
        const patch = { state: step.value };
        if (needsCloseFields && /^resolved|^closed/.test(step.label.toLowerCase())) {
          patch.close_code = "Solution provided";
          patch.close_notes = "seeded";
        }
        await api("PATCH", `/api/now/table/${table}/${sysId}`, {}, patch);
        console.log(`    -> ${step.label}`);
      } catch (err) {
        console.log(`    state ${step.label} failed: ${err.message.slice(0, 120)}`);
        break;
      }
    }
  }
  return created;
}

async function firstGroupMember(api, groupSysId) {
  if (!firstGroupMember.cache) {
    const members = await api("GET", "/api/now/table/sys_user_grmember", {
      sysparm_query: `group=${groupSysId}`,
      sysparm_limit: 1,
      sysparm_fields: "user"
    });
    firstGroupMember.cache = members[0]?.user?.value || members[0]?.user;
    if (!firstGroupMember.cache) throw new Error("Group has no members");
  }
  return firstGroupMember.cache;
}

async function clean(api, types, prefix) {
  let deleted = 0;
  for (const table of types) {
    try {
      const rows = await api("GET", `/api/now/table/${table}`, {
        sysparm_query: `short_descriptionSTARTSWITH${prefix}`,
        sysparm_limit: 500,
        sysparm_fields: "sys_id,number"
      });
      for (const row of rows) {
        await api("DELETE", `/api/now/table/${table}/${row.sys_id}`);
        deleted++;
      }
      if (rows.length) console.log(`${table}: deleted ${rows.length} seeded rows`);
    } catch (err) {
      console.log(`${table}: cleanup issue - ${err.message.slice(0, 120)}`);
    }
  }
  if (deleted) console.log(`Cleanup complete: ${deleted} records removed\n`);
  else console.log("No previous seeded records found\n");
}

main();
