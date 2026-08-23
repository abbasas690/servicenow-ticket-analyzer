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
| `background.js` | Orchestrator (service worker). Message handlers: `PING`, `COUNT`, `RUN` — NO metadata lookups of any kind. Scope comes from `msg.groups[]` = queue NAMES hardcoded in settings (NO `resolveGroups`/`fetchMemberMap` during pulls); state labels for the timeline engine come from vendored `lib/statechoices.js` OOB maps (NO live `sys_choice` fetch); ackn membership check uses the flat configured team-member NAME list applied to EVERY selected queue (`membersByQueue[queueName] = teamNames`). RUN accepts `filterSets[]`: each set is a fully server-side encoded query (table + conditions + queue scope — NO assignee filtering, team members are for ackn detection only); sets MAY mix ticket types — records are grouped per table and unioned by sys_id, then per-table activity-feed passes (fetchTimelineEvents is table-scoped) feed analyzeAll; one runs[] entry per set. Ackn membership comes from `pluginSettings.defaults.teamMembers` read directly from storage at run time (NOT from the panel payload); memberSysIds in legacy saved filters are scrubbed before query build | |
| `panel/panel.html|css|js` | Side panel UI. Ticket-type dropdown + ServiceNow-style condition builder (`condRows`: column + operator + value rows joined by AND/OR; fields: assigned_to/state/priority/incident_state/group/ci/short_description/number/created/closed/resolved; ref columns offer is-empty/is-not-empty only — no value resolution needed; state/priority dropdowns were removed in favor of conditions; choice dropdowns come from `lib/statechoices.js` OOB maps, NO server CHOICES fetch), filter-list card, progress bar, log (click header for centered popup with Copy all). Queue scope + team members come from `pluginSettings.defaults.{queues[],teamMembers[]}` as plain NAME strings (options page); Connect is LOCAL-ONLY validation (https URL + at least one queue name) and makes ZERO server calls. Builds encoded query via `lib/querybuilder.js`. Run = pull only; viewer tab is NOT auto-opened — user clicks "Open data view". Gear button opens the options page |
| `settings/settings.html|js` | Options page (`chrome.runtime.openOptionsPage`). Edits `chrome.storage.local.pluginSettings`: `{version:2, instanceUrl, defaults:{ticketType, queues:[name...], teamMembers:[name...]}, params:{tablePageSize, debugResponses}}` (the legacy `ai:{modelId}` key is simply ignored on read). Queues/members are one NAME per line (legacy `Name \| sys_id` lines are accepted on read — the `\| sys_id` tail is stripped; legacy `{name,sysId}` objects migrate to their `.name`). No JSON export/import — storage only. Background applies params in makeClient |
| `viewer/viewer.html|js` | Full-tab table view of the combined pulled dataset (`chrome.storage.local.lastData`): search, column sort, live DATA_UPDATED refresh, spreadsheet-style inline cell editing (double-click; Enter/Tab navigation; debounced write-back to lastData + DATA_UPDATED broadcast), the Excel export button, and "Extract" (Shift+click = re-run all) — runs the regex heuristic (`AiExtract.extractHeuristic`) over each ticket's closeNotes and fills solutionType/rootCause (saved back to lastData). Export FILLS the user's own formatted workbook via ZIP-LEVEL SURGERY with vendored fflate (`lib/vendor/fflate.min.js`, global `fflate`): unzip template, map sheet name→path through `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` (name matched case-insensitively, `_`/space interchangeable), rewrite ONLY that sheet's XML — rows before the auto-detected header row (found by "reference" text in column E, resolving `t="s"` sharedStrings) kept verbatim, rows ≥ header+1 dropped and replaced by generated `t="inlineStr"` cells per fixed column map (E number … P resumeTime, Q solutionType, R rootCause; timeline columns via fmtInstant instance-clock offset) that inherit the template's per-column `s=` style harvested from its first data rows (borders/number formats), `<dimension>` updated — every other zip entry re-emitted byte-identical. Sheet lookup normalizes names (`_`/space/case-insensitive, exact then loose) via workbook.xml rels and NEVER silently falls back to another sheet (a wrong-sheet fill once emptied the user's report). If formula rows get deleted, strip `xl/calcChain.xml` (+ its Content_Types Override + workbook rel) and set `fullCalcOnLoad="1"` on `<calcPr>` or Excel raises its repair dialog on stale chain refs. NEVER regenerate the workbook with a spreadsheet library (ExcelJS/SheetJS re-serialization corrupts formatted templates → Excel "repair" prompt). Template cached base64 in `chrome.storage.local.snXlsxTemplate` (click the toolbar label to clear/re-pick) |
| `analysis/report.js` | Pure report-derivation module (`globalThis.Report`): `deriveType` (INC/REQ/PTASK prefix), SLA table {P1:2/4,P2:4/8,P3:1/5,P4:10/15} with P5 clamped to P4, business hours 08:00–17:00 Mon–Fri, `calcBusinessHours`/`calcIncCurrentHours`/`calcResponseSLA`/`calcTotalAgeDays` (=hours/9), `normDate` → dd-MM-yyyy HH:mm:ss, and `buildReport(row, fmt)` (memoized on the row) producing every All_Ticket_Details derived column. Used by viewer columns AND the template export |
| `analysis/workbook.js` | Pure `buildWorkbook(rows, groupName)` → SheetJS workbook with Tickets (22 standard + timeline columns + solutionType/rootCause) + Summary sheets. Used by the viewer page |
| `analysis/aiextract.js` | Pure regex helpers: `extractHeuristic(notes)` → `{solutionType:"Permanent fix"|"Workaround", rootCause}` from closure-note text patterns (permanent yes/no lines, workaround/temporary wording, root-cause labels or sentences) + `tidyRootCause`. Local LLM inference (transformers.js worker pool) was REMOVED — do not reintroduce it. Attached to `globalThis.AiExtract` like other pure modules |
| `content/content.js` | Content script injected into ServiceNow tabs. Relays same-origin `fetch` requests (message type `SN_FETCH`) with `X-UserToken` header |
| `lib/servicenow.js` | `ServiceNowClient`: Table API pagination, count via `x-total-count`, per-ticket activity-feed reads. Pluggable `transport` + `onDiagnostic` hooks; `#request` emits one diagnostic per attempt: `kind:"ok"` (with ms/via/token-source/truncated query) on 2xx, `kind:"warn"` on retryable network/429/5xx with attempt number (`rateLimited:true` on 429), `kind:"err"` before throwing; note-style warns (`{kind:"warn",note}`) surface non-HTTP events like endpoint fallbacks. `fetchTimelineEvents(sysIds, fieldNames, onProgress, signal, tableName)` is the ONLY timeline source: per ticket it calls the form's own feed — `list_history.do?sysparm_type=list_history&table=<t>&action=get_new_entries&...&sys_id=<id>` WITHOUT `sysparm_timestamp` (returns the complete entry dump newest-first; `entries[].changes[]` carry canonical `field_name` + display-label old/new values; entry-level `sys_created_on` is RAW UTC while `sys_created_on_adjusted` is instance display) parsed by `Analysis.extractEventsFromListHistory`; on error/non-JSON it falls back to `/api/now/v1/activity/stream` + text-anchor parser — choice probed once and memoized in `activitySource`. sys_audit/sys_history_line table paths were REMOVED (feed verified complete incl. assignment_group). When `client.debugResponses` is set (settings toggle), ok-diagnostics carry `bodyRows` + truncated `bodyPreview`. Legacy metadata resolvers (`resolveGroups`, `fetchMemberMap`, `fetchUsersByIds`, `resolveUserNames`, `fetchUserGroups`, `findUserIdByUsername`, `fetchChoices`, `fetchStateMap`) were DELETED — the plugin never reads `sys_choice`/`sys_user_group`/`sys_user_grmember`/`sys_user` at all |
| `lib/statechoices.js` | Hardcoded out-of-box state maps per ticket table (`snStateMap(table)` value→label, task-family fallback) + priority choices (`SN_PRIORITY_CHOICES`) + list form (`snStateChoices`). Used by panel condition dropdowns AND the background timeline engine instead of live `sys_choice` fetches. If an instance customized state labels, these OOB maps must be updated or On Hold detection misfires |
| `lib/querybuilder.js` | Pure function `buildEncodedQuery(filters)` → ServiceNow encoded query string; also `encodeConditions(conds)` for the panel's AND/OR condition builder (`assigned_toISEMPTY^ORstate=2^...`, date ops via `gs.dateGenerate`). Conditions fragment MUST be emitted FIRST: SN evaluates encoded queries strictly left-to-right, so a `^OR` placed after other ANDed scopes would OR over the whole preceding expression and leak past queue/member scoping. Queue scope (`assignment_group.nameIN…`) is emitted UNCONDITIONALLY whenever groupNames are present — the old `onlyMyQueue` checkbox gate was removed after it silently dropped queue scoping from pulls (assignee-only queries returned 0 rows); a legacy flag in stored filters is simply ignored. Names go through `sanitizeValue` (quotes/backslashes stripped) — group names containing commas cannot be expressed in an IN list |
| `analysis/phase2.js` | Pure functions `extractTimelines(auditRows, ctx)` and `analyzeAll(...)` implementing the four timestamp rules; matching is NAME-space end-to-end: ctx carries `queueName`, `memberNames`, `snapshotGroupName` (case-insensitive, trimmed via local `nameKey`); `extractEventsFromActivity(entries)` parses raw `/api/now/v1/activity/stream` entries into standard events — structured `.changes[]` shape first, then ENGLISH text anchors (`"<label> changed from X to Y [on DATE]"` for Assignment group/Assigned to/State) with tolerant datetime scanning via local `parseSnDisplayMs`; undated entries are skipped, duplicates deduped; `extractEventsFromListHistory(payload)` parses the `list_history.do` full-load JSON — groups by `document_id`, uses entry-level `sys_created_on` (raw UTC) as `at` (never `sys_created_on_adjusted`), renames `incident_state`→`state`, keeps all fields for caller-side filtering. Attaches to `globalThis.Analysis` so the service worker, pages, and node tests share one global |
| `lib/xlsx.full.min.js` | Vendored SheetJS. Do not edit |
| `tools/seed-data.js` | Standalone Node seeder: creates tickets of every type via REST with staged updates (group→member→hold-ish→progress→resolve/closed) so ticket history (sys_audit and the activity feed) gets real rows. `node tools/seed-data.js <instance-url> [--count=N] [--clean] [--members-file=team.txt]`. Assignees come from `--members-file` (or interactive paste) in the `Name \| sys_id` format, round-robin across tickets — the NAMES should match pluginSettings.defaults.teamMembers or acknowledgement dates won't fire; with no members given it falls back to the group's first sys_user_grmember roster entry (mismatch warning printed). Prompts for admin creds |

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

### No-permission design (hardcoded scope)
The default flow makes ZERO metadata lookups: no `sys_choice`, `sys_user_group`,
`sys_user_grmember`, or `sys_user` reads — and no such resolver methods exist
anymore (they were deleted from `lib/servicenow.js`). Some users lack permission
for those tables, so all scoping data is hardcoded in settings instead:
- Queues and team members = plain NAME strings in `pluginSettings.defaults`
  (one name per line in the options page; matching is case-insensitive).
- State/priority labels for condition dropdowns AND timeline rules come from
  `lib/statechoices.js` OOB maps.
Only the selected ticket table + the per-ticket activity feed (`list_history.do`)
are ever read during pulls. COUNT/RUN are the sole server operations; panel
Connect is local-only validation.

### The four timeline rules (business requirements — never change semantics without asking)
Computed in `extractTimelines()` from timeline events (`assignment_group`,
`assigned_to`, `state` fields), replayed in chronological order:

1. **assignTime** — LAST time `assignment_group` changed TO the target queue.
   Born-in-queue fallback: if NO group-change events exist but the ticket's
   CURRENT group == queue, assignTime = opened_at (covers auto-routed tickets
   whose group was set at creation; inserts produce no audit rows).
   assignTime is CLAMPED to never precede opened_at (backdated demo audits);
   the clamp does not affect ackn eligibility, which stays event-based.
   Each ticket is measured against ITS OWN current group
   (ctx.queueName = snapshotGroupName, name-space compare), and ackn checks
   membership of that queue's member set. Member sets are the flat configured
   team-member NAME list from settings applied to EVERY selected queue.
2. **acknTime** — LAST time `assigned_to` became a member of the queue's team,
   counted ONLY if it occurs at/after the latest queue-entry event. Earlier
   assignments are ignored by design.
3. **suspendTime** — FIRST transition INTO "On Hold" while current group == queue.
   State labels come from the hardcoded `lib/statechoices.js` OOB maps.
   Feed events carry DISPLAY LABELS ("On Hold"), legacy sys_audit rows carried
   raw values ("3") — both accepted: each value is resolved via stateMap key
   lookup first, falling back to treating it as the label itself.
4. **resumeTime** — FIRST post-suspend transition to "In Progress"; if none, fall
   back to first post-suspend "Resolved". Null if never resumed.

On Hold transitions while assigned elsewhere do NOT count. Group changes reset
queue context.

### Performance constraints
- Phase 2 reads the activity feed PER TICKET (`list_history.do`, one request each) — no batching exists; keep per-ticket progress reporting.
- Table API pages of 1000. Exports can reach Excel's 1,048,576-row ceiling.
- Keep the ServiceNow tab open during exports (relay + node affinity).

### Timezone contract
- ServiceNow REST raw datetimes are UTC; `parseUtc()` appends Z before parsing.
- All displayed times must follow the INSTANCE clock (what the Activity UI shows),
  never the browser. The instance's effective zone may have NO API-visible source:
  `sys_user.time_zone`, `sys_user_preference`, and `glide.sys.default.tz` can all be
  empty while SN still renders display values in the server's zone (e.g. Los Angeles).
  Therefore the ONLY reliable oracle is SN's own display/raw pair per record.
- `detectSnOffsetMs(rows)` (analysis/workbook.js) infers the offset as the MEDIAN of
  openedAt-display minus openedAtRaw pairs across rows (up to 200) — not first-row-only.
- `rowOffsetMs(row, fallback)` gives each row's OWN offset from its pair; viewer
  `fmtInstant(v, row)` and Excel `buildWorkbook` use it so timeline columns match the
  Activity UI even when rows span DST seasons (winter -8h vs summer -7h). Rows carry
  raw companions (openedAtRaw etc.) — keep fetching them via `sysparm_display_value:"all"`.
- Display values are parsed format-tolerantly (`parseSnDisplayMs` in workbook.js):
  ISO yyyy-MM-dd, dd-MM-yyyy, dd.MM.yyyy, MM/dd/yyyy with optional AM/PM. Org
  instances commonly render e.g. "10-08-2026 11:06:40" for raw "2026-08-10 05:36:40"
  (day-first + profile tz). Raw REST values are always ISO and need no tolerance.
- Empty timeline events on a run where tickets clearly HAVE history usually means
  the activity feed returned nothing for them (blocked `.do` endpoint or the
  form's Activity formatter config doesn't track a needed field). The viewer
  shows a warning banner; check one ticket's Activity section renders changes
  before suspecting the plugin.
- Tests: `node tools/tz-unit-test.js` (offline, exits non-zero on failure);
  `TZ_INSTANCE=… TZ_USER=… TZ_PASS=… node tools/tz-live-test.js` (verifies rendered
  times equal SN's display values on scenario + cross-DST tickets).

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

Regression-test any change to timeline rules or query building with
`node tools/phase2-unit-test.js` (exits non-zero on failure) against these cases:
pre-queue ackn ignored, first-On-Hold wins, direct-resolve fallback, suspend only
while in queue, group re-entry takes latest, excludeClosed suppressed when states picked.
Regression-test the activity source chain and the activity text parser
with `node tools/activity-client-test.js` and `node tools/activity-parse-test.js`.
Regression-test the closure-note regex extractor with `node tools/ai-parse-test.js`.
Regression-test the report/SLA derivations with `node tools/report-test.js`.
Regression-test the pull cache helpers with `node tools/cache-test.js`.

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
