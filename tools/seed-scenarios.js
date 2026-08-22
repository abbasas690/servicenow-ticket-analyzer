#!/usr/bin/env node
const readline = require("readline");

const args = process.argv.slice(2);
const CLEAN = args.includes("--clean");
const INSTANCE = (args.find(a => a.startsWith("http")) || process.env.SEED_INSTANCE || "").replace(/\/+$/, "");
const STEP_DELAY_MS = 2200;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function question(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); });
  });
}

let API = null;

async function step(label = "wait") {
  await sleep(STEP_DELAY_MS);
  console.log(`    ${label}`);
}

async function patch(table, sysId, body, label) {
  await API("PATCH", `/api/now/table/${table}/${sysId}`, {}, body);
  console.log(`    -> ${label || Object.keys(body).join(",")}`);
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

  async function api(method, path, params, body) {    const url = new URL(instanceUrl + path);
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
    if (!res.ok && !(method === "GET" && res.status === 404)) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return json.result !== undefined ? json.result : json;
  }

  API = api;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const marker = `[QA ${stamp}]`;

  if (CLEAN) {
    await clean(api);
    return;
  }

  console.log("Resolving admin user...");
  const admins = await api("GET", "/api/now/table/sys_user", {
    sysparm_query: `user_name=${user}`,
    sysparm_limit: 1,
    sysparm_fields: "sys_id,name"
  });
  const admin = admins[0];
  if (!admin) throw new Error(`User "${user}" not found`);
  console.log(`Admin: ${admin.name} (${admin.sys_id})`);

  const ALPHA = "SN QA Queue Alpha";
  const BETA = "SN QA Queue Beta";
  const alphaId = await ensureGroup(api, ALPHA, admin.sys_id);
  const betaId = await ensureGroup(api, BETA, admin.sys_id);
  console.log(`Groups ready: ${ALPHA}=${alphaId}, ${BETA}=` + `${betaId}`);

  const incStates = await fetchStateChoices(api, "incident");
  const pickInc = pred => incStates.find(c => pred(c.label.toLowerCase()));
  const INC = {
    prog: pickInc(l => l.includes("in progress")),
    hold: pickInc(l => l.includes("on hold")),
    res: pickInc(l => l.startsWith("resolved")),
    closed: pickInc(l => l.startsWith("closed"))
  };
  for (const [k, v] of Object.entries(INC)) {
    if (!v) throw new Error(`incident state not found: ${k}`);
  }

  const results = [];
  const record = (name, number, expect) => results.push({ name, number, expect });

  const mkIncident = async (groupId, tag) => {
    const payload = {
      short_description: `${marker} ${tag}`,
      description: "Seeded by tools/seed-scenarios.js",
      caller_id: admin.sys_id
    };
    if (groupId) payload.assignment_group = groupId;
    const rec = await api("POST", "/api/now/table/incident", {}, payload);
    const number = rec.number?.display_value || rec.number;
    console.log(`  created ${number} (${tag})`);
    return rec;
  };

  const closeFields = { close_code: "Solution provided", close_notes: "seeded" };

  console.log("\nS1 happy-path (Alpha)");
  {
    const r = await mkIncident(alphaId, "S1 happy-path");
    await step("wait");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn admin");
    await patch("incident", r.sys_id, { state: INC.prog.value }, INC.prog.label);
    await patch("incident", r.sys_id, { state: INC.hold.value }, INC.hold.label);
    await patch("incident", r.sys_id, { state: INC.prog.value }, INC.prog.label + " (resume)");
    await patch("incident", r.sys_id, { state: INC.res.value, ...closeFields }, INC.res.label);
    record("S1 happy-path", number(r), "assign=created, ackn>assign, suspend=first hold, resume=InProg");
  }

  console.log("\nS2 direct-resolve (Alpha)");
  {
    const r = await mkIncident(alphaId, "S2 direct-resolve");
    await step("wait");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn admin");
    await patch("incident", r.sys_id, { state: INC.res.value, ...closeFields }, INC.res.label);
    record("S2 direct-resolve", number(r), "suspend+resume NULL (direct-resolve fallback n/a: resumed never held)");
  }

  console.log("\nS3 pre-queue ackn ignored (Alpha)");
  {
    const r = await mkIncident(null, "S3 prequeue-ackn");
    await step("wait");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn BEFORE queue");
    await patch("incident", r.sys_id, { assignment_group: alphaId }, "enter Alpha");
    await patch("incident", r.sys_id, { assigned_to: "" }, "unassign (forces new event)");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn AFTER entry");
    await patch("incident", r.sys_id, { state: INC.prog.value }, INC.prog.label);
    record("S3 prequeue-ackn", number(r), "ackn = 2nd assignment only");
  }

  console.log("\nS4 hold-before-entry ignored (Alpha)");
  {
    const r = await mkIncident(null, "S4 prequeue-hold");
    await step("wait");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn outside queue");
    await patch("incident", r.sys_id, { state: INC.hold.value }, INC.hold.label + " BEFORE entry");
    await patch("incident", r.sys_id, { assignment_group: alphaId }, "enter Alpha");
    await patch("incident", r.sys_id, { assigned_to: "" }, "unassign");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn AFTER entry");
    await patch("incident", r.sys_id, { state: INC.prog.value }, INC.prog.label);
    await patch("incident", r.sys_id, { state: INC.res.value, ...closeFields }, INC.res.label);
    record("S4 prequeue-hold", number(r), "suspend+resume NULL (hold was outside queue)");
  }

  console.log("\nS5 group re-entry latest wins (Alpha/Beta)");
  {
    const r = await mkIncident(alphaId, "S5 reentry");
    await step("wait");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn v1");
    await patch("incident", r.sys_id, { assignment_group: betaId }, "move to Beta");
    await patch("incident", r.sys_id, { assignment_group: alphaId }, "re-enter Alpha");
    await patch("incident", r.sys_id, { assigned_to: "" }, "unassign");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn v2");
    await patch("incident", r.sys_id, { state: INC.prog.value }, INC.prog.label);
    await patch("incident", r.sys_id, { state: INC.res.value, ...closeFields }, INC.res.label);
    record("S5 reentry", number(r), "assign=2nd Alpha entry, ackn=v2");
  }

  console.log("\nS6 never acknowledged (Beta)");
  {
    const r = await mkIncident(betaId, "S6 never-acked");
    await step("wait");
    await patch("incident", r.sys_id, { state: INC.prog.value }, INC.prog.label);
    record("S6 never-acked", number(r), "ackn=NULL, assign=created");
  }

  console.log("\nS7 stuck On Hold (Beta)");
  {
    const r = await mkIncident(betaId, "S7 stuck-hold");
    await step("wait");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn admin");
    await patch("incident", r.sys_id, { state: INC.hold.value }, INC.hold.label + " (current)");
    record("S7 stuck-hold", number(r), "suspend set, resume=NULL (still On Hold)");
  }

  console.log("\nS8 closed w/ dates (Beta)");
  {
    const r = await mkIncident(betaId, "S8 closed-dates");
    await step("wait");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn admin");
    await patch("incident", r.sys_id, { state: INC.hold.value }, INC.hold.label);
    await patch("incident", r.sys_id, { state: INC.prog.value }, INC.prog.label + " (resume)");
    await patch("incident", r.sys_id, { state: INC.closed.value, ...closeFields }, INC.closed.label);
    record("S8 closed-dates", number(r), "full path; use for Closed-date filter tests");
  }

  console.log("\nS9 outside-hold not counted (Beta->Alpha)");
  {
    const r = await mkIncident(betaId, "S9 outside-hold");
    await step("wait");
    await patch("incident", r.sys_id, { assigned_to: admin.sys_id }, "ackn admin");
    await patch("incident", r.sys_id, { state: INC.hold.value }, INC.hold.label + " IN queue");
    await patch("incident", r.sys_id, { assignment_group: alphaId }, "move to Alpha");
    await patch("incident", r.sys_id, { state: INC.prog.value }, INC.prog.label);
    await patch("incident", r.sys_id, { state: INC.hold.value }, INC.hold.label + " OUTSIDE queue");
    await patch("incident", r.sys_id, { state: INC.res.value, ...closeFields }, INC.res.label);
    record("S9 outside-hold", number(r), "final queue=Alpha: assign=entry, pre-Alpha ackn+hold ignored -> suspend/resume/ackn NULL");
  }

  await seedOtherTables(api, betaId, admin, marker, record);

  console.log("\n================ EXPECTED RESULTS ================");
  for (const r of results) {
    console.log(`${r.number.padEnd(12)} ${r.name.padEnd(34)} ${r.expect}`);
  }
  console.log("\nInclude BOTH 'SN QA Queue Alpha' and 'SN QA Queue Beta' when you Run.");
  console.log(`Cleanup marker: short_description STARTSWITH [QA  (node tools/seed-scenarios.js <url> --clean)`);
}

function number(recLike) {
  return typeof recLike === "string" ? recLike : (recLike.number?.display_value || recLike.number || "?");
}

async function ensureGroup(api, name, adminId) {
  const found = await api("GET", "/api/now/table/sys_user_group", {
    sysparm_query: `name=${name}`,
    sysparm_limit: 1,
    sysparm_fields: "sys_id"
  });
  if (found[0]) {
    await ensureMembership(api, found[0].sys_id, adminId);
    return found[0].sys_id;
  }
  const rec = await api("POST", "/api/now/table/sys_user_group", {}, { name, description: "Created by tools/seed-scenarios.js" });
  await ensureMembership(api, rec.sys_id, adminId);
  return rec.sys_id;
}

async function ensureMembership(api, groupId, userId) {
  const found = await api("GET", "/api/now/table/sys_user_grmember", {
    sysparm_query: `group=${groupId}^user=${userId}`,
    sysparm_limit: 1,
    sysparm_fields: "sys_id"
  });
  if (found[0]) return;
  await api("POST", "/api/now/table/sys_user_grmember", {}, { group: groupId, user: userId });
}

async function seedOtherTables(api, groupId, admin, marker, record) {
  console.log("\nT1/T2 sc_task (Beta)");
  try {
  const taskChoices = await fetchStateChoices(api, "sc_task");
  const tOpen = taskChoices.find(c => c.label.toLowerCase() === "open") || taskChoices[0];
  const tProg = taskChoices.find(c => c.label.toLowerCase().includes("in progress"));
  const tClosed = taskChoices.find(c => c.label.toLowerCase().startsWith("closed complete") || c.label.toLowerCase() === "closed");
  const tSkipped = taskChoices.find(c => c.label.toLowerCase().startsWith("closed skipped"));
  for (const [tag, steps] of [
    ["T1 task-progress", [tProg, tClosed].filter(Boolean)],
    ["T2 task-skipped", [tSkipped].filter(Boolean)]
  ]) {
    const rec = await api("POST", "/api/now/table/sc_task", {}, {
      short_description: `${marker} ${tag}`,
      assignment_group: groupId
    });
    console.log(`  created ${number(rec)} (${tag})`);
    await step("wait");
    await patch("sc_task", rec.sys_id, { assigned_to: admin.sys_id }, "ackn admin");
    for (const s of steps) {
      await step("wait");
      await patch("sc_task", rec.sys_id, { state: s.value }, s.label);
    }
    record(tag, number(rec), `no On Hold choice in task -> suspend/resume NULL`);
  }
  } catch (err) { console.log(`  sc_task seeding issue: ${err.message.slice(0, 160)}`); }

  console.log("\nT3/T4 problem (Beta)");
  try {
  const probChoices = await fetchStateChoices(api, "problem");
  const assess = probChoices.find(c => c.label.toLowerCase() === "assess") ||
                 probChoices.find(c => c.label.toLowerCase().includes("root cause")) || probChoices[0];
  const p1 = await api("POST", "/api/now/table/problem", {}, {
    short_description: `${marker} T3 problem-assess`,
    assignment_group: groupId
  });
  console.log(`  created ${number(p1)} (T3)`);
  await step("wait");
  await patch("problem", p1.sys_id, { assigned_to: admin.sys_id }, "ackn admin");
  await patch("problem", p1.sys_id, { state: assess.value }, assess.label);
  record("T3 problem-assess", number(p1), "assign=created, ackn set, suspend/resume NULL");

  const p2 = await api("POST", "/api/now/table/problem", {}, {
    short_description: `${marker} T4 problem-late-group`
  });
  console.log(`  created ${number(p2)} (T4, no group at birth)`);
  await step("wait");
  await patch("problem", p2.sys_id, { assigned_to: admin.sys_id }, "ackn before queue");
  await patch("problem", p2.sys_id, { assignment_group: groupId }, "enter Beta");
  await patch("problem", p2.sys_id, { assigned_to: "" }, "unassign");
  await patch("problem", p2.sys_id, { assigned_to: admin.sys_id }, "ackn after entry");
  record("T4 problem-late-group", number(p2), "pre-queue ackn only -> ackn NULL (policies block reassign)");
  } catch (err) { console.log(`  problem seeding issue: ${err.message.slice(0, 160)}`); }

  console.log("\nT5 change_request (Beta)");
  try {
  const chg = await api("POST", "/api/now/table/change_request", {}, {
    short_description: `${marker} T5 change-assess`,
    type: "normal",
    risk: "moderate",
    assignment_group: groupId
  });
  console.log(`  created ${number(chg)} (T5)`);
  await step("wait");
  await patch("change_request", chg.sys_id, { assigned_to: admin.sys_id }, "ackn admin");
  await patch("change_request", chg.sys_id, { state: "-4" }, "Assess");
  record("T5 change-assess", number(chg), "CHG state machine caps at Assess");
  } catch (err) { console.log(`  change_request seeding issue: ${err.message.slice(0, 160)}`); }
}

async function fetchStateChoices(api, table) {
  const q = async name => api("GET", "/api/now/table/sys_choice", {
    sysparm_query: `name=${name}^element=state^inactive=false`,
    sysparm_limit: 100,
    sysparm_fields: "value,label"
  });
  let choices = await q(table);
  if (choices.length === 0 && table !== "task") choices = await q("task");
  return choices;
}

async function clean(api) {
  const types = ["incident", "change_request", "problem", "sc_req_item", "sc_task"];
  let deleted = 0;
  for (const table of types) {
    const rows = await api("GET", `/api/now/table/${table}`, {
      sysparm_query: "short_descriptionSTARTSWITH[QA",
      sysparm_limit: 500,
      sysparm_fields: "sys_id,number"
    }).catch(() => []);
    for (const row of rows) {
      await api("DELETE", `/api/now/table/${table}/${row.sys_id}`).catch(() => {});
      deleted++;
    }
    if (rows.length) console.log(`${table}: deleted ${rows.length}`);
  }
  console.log(deleted ? `Cleanup complete: ${deleted} records removed` : "No [QA seeded records found");
}

main();
