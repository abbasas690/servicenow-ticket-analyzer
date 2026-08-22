# AGENTS.md

Instructions for AI coding agents working in this repository.

## Project Overview

Chrome extension (Manifest V3, Side Panel UI) that pulls incident tickets from a
ServiceNow instance via REST, extracts per-ticket queue timelines, and exports an
Excel (.xlsx) analysis workbook.

- Target instance: `https://dev385266.service-now.com` (developer instance, admin role)
- Auth model: reuses the user's browser login session. No API keys or Basic auth.
- Two-phase pipeline: Phase 1 = paginated ticket list; Phase 2 = audit-history timelines.

## File Map

| Path | Role |
|---|---|
| `manifest.json` | MV3 config: side panel, content script on `*.service-now.com`, permissions (`storage`, `unlimitedStorage`, `downloads`, `sidePanel`, `cookies`, `scripting`) |
| `background.js` | Orchestrator (service worker). Message handlers: `PING`, `CHOICES`, `MY_GROUPS`, `MEMBERS`, `USERS`, `COUNT`, `RUN`. Owns `smartFetch` auth transport, current-user + group resolution, pipeline stages, row merging into `lastData`. RUN accepts `filterSets[]`: each set is a fully server-side encoded query (table + state + priority + assignee + closed-dates + queue scope); sets MAY mix ticket types — records are grouped per table and unioned by sys_id, then per-table audit passes (fetchAudit is table-scoped) feed analyzeAll with that table's stateMap; one runs[] entry per set |
| `panel/panel.html|css|js` | Side panel UI. Ticket-type dropdown + ServiceNow-style condition builder (`condRows`: column + operator + value rows joined by AND/OR; fields: assigned_to/state/priority/incident_state/group/ci/short_description/number/created/closed/resolved; ref columns offer is-empty/is-not-empty only — no value resolution needed; state/priority dropdowns were removed in favor of conditions), filter-list card, progress bar, log (click header for centered popup with Copy all). Queue scope + team members are NOT on the panel anymore — they come from `pluginSettings.defaults.{queues[],teamMembers[]}` (options page); panel resolves member names→sys_ids via USERS at connect and re-applies settings live via storage.onChanged. Builds encoded query via `lib/querybuilder.js`. Run = pull only; viewer tab is NOT auto-opened — user clicks "Open data view". Gear button opens the options page |
| `settings/settings.html|js` | Options page (`chrome.runtime.openOptionsPage`). Edits `chrome.storage.local.pluginSettings`: `{version, instanceUrl, defaults:{ticketType, queues[], teamMembers[]}, params:{auditBatchSize, tablePageSize}}`. Legacy single `queueName` migrates into `queues[]` on load; old localStorage `snGroup` is a last-resort fallback in the panel. No JSON export/import — storage only. Background applies params in makeClient |
| `viewer/viewer.html|js` | Full-tab table view of the combined pulled dataset (`chrome.storage.local.lastData`): search, column sort, live DATA_UPDATED refresh, spreadsheet-style inline cell editing (double-click; Enter/Tab navigation; debounced write-back to lastData + DATA_UPDATED broadcast), and the Excel export button. Export FILLS the user's own formatted workbook via ZIP-LEVEL SURGERY with vendored fflate (`lib/vendor/fflate.min.js`, global `fflate`): unzip template, map sheet name→path through `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` (name matched case-insensitively, `_`/space interchangeable), rewrite ONLY that sheet's XML — rows before the auto-detected header row (found by "reference" text in column E, resolving `t="s"` sharedStrings) kept verbatim, rows ≥ header+1 dropped and replaced by generated `t="inlineStr"` cells per fixed column map (E number … P resumeTime; timeline columns via fmtInstant instance-clock offset) that inherit the template's per-column `s=` style harvested from its first data rows (borders/number formats), `<dimension>` updated — every other zip entry re-emitted byte-identical. Sheet lookup normalizes names (`_`/space/case-insensitive, exact then loose) via workbook.xml rels and NEVER silently falls back to another sheet (a wrong-sheet fill once emptied the user's report). If formula rows get deleted, strip `xl/calcChain.xml` (+ its Content_Types Override + workbook rel) and set `fullCalcOnLoad="1"` on `<calcPr>` or Excel raises its repair dialog on stale chain refs. NEVER regenerate the workbook with a spreadsheet library (ExcelJS/SheetJS re-serialization corrupts formatted templates → Excel "repair" prompt). Template cached base64 in `chrome.storage.local.snXlsxTemplate` (click the toolbar label to clear/re-pick) |
| `analysis/workbook.js` | Pure `buildWorkbook(rows, groupName)` → SheetJS workbook with Tickets (22 standard + timeline columns) + Summary sheets. Used by the viewer page |
| `content/content.js` | Content script injected into ServiceNow tabs. Relays same-origin `fetch` requests (message type `SN_FETCH`) with `X-UserToken` header |
| `lib/servicenow.js` | `ServiceNowClient`: Table API pagination, count via `x-total-count`, choice lists, group/member resolution (`fetchMemberMap` single `groupIN` query), user resolution (`fetchUsersByIds`, `resolveUserNames`), batched `sys_audit` queries. Pluggable `transport` + `onDiagnostic` hooks; `#request` emits one diagnostic per attempt: `kind:"ok"` (with ms/via/token-source/truncated query) on 2xx, `kind:"warn"` on retryable network/429/5xx with attempt number, `kind:"err"` before throwing |
| `lib/querybuilder.js` | Pure function `buildEncodedQuery(filters)` → ServiceNow encoded query string; also `encodeConditions(conds)` for the panel's AND/OR condition builder (`assigned_toISEMPTY^ORstate=2^...`, date ops via `gs.dateGenerate`). Conditions fragment MUST be emitted FIRST: SN evaluates encoded queries strictly left-to-right, so a `^OR` placed after other ANDed scopes would OR over the whole preceding expression and leak past queue/member scoping |
| `analysis/phase2.js` | Pure functions `extractTimelines(auditRows, ctx)` and `analyzeAll(...)` implementing the four timestamp rules |
| `lib/xlsx.full.min.js` | Vendored SheetJS. Do not edit |
| `tools/seed-data.js` | Standalone Node seeder: creates tickets of every type via REST with staged updates (group→member→hold-ish→progress→resolve/closed) so sys_audit gets real rows. `node tools/seed-data.js <instance-url> [--count=N] [--clean]`; prompts for admin creds |

## Critical Knowledge (do not regress)

### Authentication chain (`smartFetch` in background.js)
Requests MUST go through this order:
1. Find an open tab matching the instance origin. **No tab → fail fast with a clear message** (session auth is impossible without it).
2. Get CSRF token: try `g_ck` cookie via `chrome.cookies`; if absent, inject MAIN-world script (`chrome.scripting.executeScript`, `world: "MAIN"`) reading the page global `g_ck`.
3. Relay through the tab's content script (same-origin fetch, cookies first-party).
4. Direct `fetch` from the service worker is last-resort only.

Why this shape (hard-won):
- MV3 service-worker fetches are cross-site: third-party cookie blocking breaks session cookies.
- Content scripts run in an **isolated world** — they CANNOT see page globals like `g_ck`. The token must be passed *into* them from the background.
- On current releases there is no reliable `g_ck` cookie; the token lives as a JS variable in page context.
- ServiceNow rejects session-authenticated API calls missing `X-UserToken` with 401.
- Users must refresh their ServiceNow tab after reloading the extension, or the content script won't exist yet.

### Current-user identity (`getCurrentUserId` in background.js)
Resolution order: MAIN-world injection reading `g_user.userID` (fallback `NOW.user_id`)
→ decode `glide_returning_auth_user` cookie (base64 `user|timestamp|sig`) →
`findUserIdByUsername`. Group memberships come from `sys_user_grmember`
(`fetchUserGroups`). The panel shows these as a dropdown; manual entry stays as fallback.

### The four timeline rules (business requirements — never change semantics without asking)
Computed in `extractTimelines()` from `sys_audit` rows (`assignment_group`,
`assigned_to`, `state` fields), replayed in chronological order:

1. **assignTime** — LAST time `assignment_group` changed TO the target queue.
   Born-in-queue fallback: if NO group-change events exist but the ticket's
   CURRENT group == queue, assignTime = opened_at (covers auto-routed tickets
   whose group was set at creation; inserts produce no audit rows).
   Multi-queue mode: panel shows a slushbucket (ServiceNow column-picker style)
   with ALL of the user's groups included by default; add/remove via buttons or
   double-click, manual comma-separated input for non-member queues. Each ticket
   is measured against ITS OWN current group (ctx.queueSysId = snapshotGroupId),
   and ackn checks membership of that specific queue's member set. Member sets
   come from one `groupIN` sys_user_grmember query (fetchMemberMap), not per-queue.
2. **acknTime** — LAST time `assigned_to` became a member of the queue's team,
   counted ONLY if it occurs at/after the latest queue-entry event. Earlier
   assignments are ignored by design.
3. **suspendTime** — FIRST transition INTO "On Hold" while current group == queue.
   State labels come from the instance's own `sys_choice` list (fetched live).
4. **resumeTime** — FIRST post-suspend transition to "In Progress"; if none, fall
   back to first post-suspend "Resolved". Null if never resumed.

On Hold transitions while assigned elsewhere do NOT count. Group changes reset
queue context.

### Performance constraints
- Phase 2 batches ~80 sys_ids per `sys_audit` request (`documentkeyIN...`) — keep batching if touching that code.
- Table API pages of 1000. Exports can reach Excel's 1,048,576-row ceiling.
- Keep the ServiceNow tab open during exports (relay + node affinity).

### Timezone contract
- ServiceNow REST raw datetimes are UTC; `parseUtc()` appends Z before parsing.
- All displayed times must follow the INSTANCE user-profile clock, not the browser:
  `detectSnOffsetMs()` (analysis/workbook.js) infers the offset from paired openedAt
  display vs raw values; viewer `fmtInstant` and Excel `fmtWithOffset` shift timeline
  columns by that offset so they match the ServiceNow Activity UI on any device.
  Rows carry raw companions (openedAtRaw/closedAtRaw/resolvedAtRaw) for detection;
  offset 0 fallback when absent.

### Download path (MV3 constraint)
The service worker never touches XLSX bytes. The viewer page loads the user's
cached template, patches only the target sheet's XML (fflate zip surgery), and
downloads via Blob + `chrome.downloads.download` — extension pages DO have
`URL.createObjectURL`, workers do NOT. Do not move export building back into
the background.

## Verification Commands

There is no bundler or package manager. Verify with node after every change:

```bash
node --check background.js && \
node --check lib/servicenow.js && \
node --check lib/querybuilder.js && \
node --check analysis/phase2.js && \
node --check panel/panel.js && \
node --check content/content.js && \
node -e "JSON.parse(require('fs').readFileSync('manifest.json'))"
```

Pure modules (`querybuilder.js`, `phase2.js`) export via `module.exports` AND
attach to `self` — testable in plain node, e.g.:

```js
const { extractTimelines } = require('./analysis/phase2.js');
```

Regression-test any change to timeline rules or query building against these cases:
pre-queue ackn ignored, first-On-Hold wins, direct-resolve fallback, suspend only
while in queue, group re-entry takes latest, excludeClosed suppressed when states picked.

Manual test loop (user performs): reload extension at `chrome://extensions`
→ refresh the ServiceNow tab → Connect → Preview count → Run export.

## Conventions

- No code comments unless asked; no emojis in output files.
- ES2022 max (MV3 service workers): private `#methods`, top-level `await` avoided.
- Modules usable in three contexts: service worker (`importScripts`, attach to `self`),
  panel page (`<script>`, globals), node tests (`module.exports`). Guard accordingly.
- All user-facing strings in English; timestamps ISO 8601.
- Never log or store full token values — prefix only (first 8 chars) in diagnostics.
- Instance URL comes from user input/storage; always validate `https://`.

## Known Limits / Roadmap

- Ticket type is selectable in the panel (incident, change_request, problem,
  sc_req_item, sc_task); the four timeline rules were designed on incident
  semantics — validate state labels per table before trusting results elsewhere.
  sc_task has no OOB "On Hold" state: suspend/resume stay null unless the label
  exists in that table's sys_choice list. Closed-state date filtering triggers on
  any label starting with "close" (Closed Complete/Incomplete/Skipped).
- Closed-state filtering uses `closed_at` BETWEEN dates; the date block appears
  only when the selected state's label is "Closed" and both dates are required.
- Audit availability depends on instance retention/roles; tickets missing audit rows
  are reported in the done-message count.
- Possible future work: resume-from-checkpoint for huge pulls, derived duration
  columns, work-notes text export, additional tables (RITM, change).
