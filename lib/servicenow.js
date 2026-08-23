class ServiceNowClient {
  constructor(instanceUrl, options = {}) {
    this.baseUrl = instanceUrl.replace(/\/+$/, "");
    this.transport = options.transport || null;
    this.onDiagnostic = options.onDiagnostic || null;
    this.pageSize = 1000;
    this.maxRetries = 4;
    this.debugResponses = false;
    this.activitySource = "";
  }

  async #request(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const target = url.toString();
    const started = Date.now();
    const q = String(params.sysparm_query || "");
    const shortQuery = q.length > 100 ? q.slice(0, 100) + "…" : q;
    const emit = extra => {
      if (!this.onDiagnostic) return;
      try {
        this.onDiagnostic({
          status: null, via: null, hadToken: null, tokenSource: null,
          path, query: shortQuery, ms: Date.now() - started,
          ...extra
        });
      } catch {}
    };
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        let res;
        if (this.transport) {
          const raw = await this.transport(target);
          if (!raw || raw.ok === false) throw new TypeError(raw?.error || "Transport failed");
          res = new Response(raw.text, { status: raw.status, headers: raw.headers || {} });
          res.snVia = raw.via;
          res.snHadToken = raw.hadToken;
          res.snTokenSource = raw.tokenSource || null;
        } else {
          res = await fetch(target, { method: "GET", credentials: "include", headers: { "Accept": "application/json" } });
          res.snVia = "direct";
          res.snHadToken = null;
        }
        if (res.status === 401 || res.status === 403) {
          emit({ kind: "err", status: res.status });
          throw new Error(
            `Auth error ${res.status} (${res.snVia}, token ${res.snHadToken ? "sent" : "MISSING"}): refresh your ServiceNow browser tab and confirm you are logged in, then press Connect again`
          );
        }
        if (res.status === 429 || res.status >= 500) {
          const rateLimited = res.status === 429;
          lastError = rateLimited
            ? new Error("Rate limited by ServiceNow (HTTP 429)")
            : new Error(`Server ${res.status}, retrying (${attempt + 1}/${this.maxRetries})`);
          emit({ kind: "warn", status: res.status, attempt: attempt + 1, rateLimited });
          await this.#sleep(1500 * Math.pow(2, attempt));
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          emit({ kind: "err", status: res.status });
          throw new Error(`HTTP ${res.status} on ${path}: ${body.slice(0, 300)}`);
        }
        const extra = {};
        if (this.debugResponses) {
          let txt = "";
          try {
            txt = await res.clone().text();
          } catch {}
          if (txt) {
            try {
              const j = JSON.parse(txt);
              if (j && Array.isArray(j.result)) extra.bodyRows = j.result.length;
            } catch {}
            extra.bodyPreview = txt.length > 300 ? txt.slice(0, 300) + "…" : txt;
          }
        }
        emit({ kind: "ok", status: res.status, via: res.snVia, hadToken: res.snHadToken, tokenSource: res.snTokenSource, ...extra });
        return res;
      } catch (err) {
        if (err instanceof TypeError) {
          lastError = err;
          emit({ kind: "warn", status: 0, attempt: attempt + 1, netError: String(err.message || err) });
          await this.#sleep(1500 * Math.pow(2, attempt));
        } else {
          if (!err.message || !/^Auth error|^HTTP /.test(err.message)) emit({ kind: "err", status: 0 });
          throw err;
        }
      }
    }
    emit({ kind: "err", status: 0, retriesExhausted: true });
    if (lastError?.message?.startsWith("Rate limited by ServiceNow")) {
      throw new Error("Rate limited by ServiceNow (HTTP 429) — wait a few minutes before running again");
    }
    throw lastError || new Error("Request failed after retries");
  }

  async #sleep(ms) {
    await new Promise(r => setTimeout(r, ms));
  }

  async count(table, encodedQuery) {
    const res = await this.#request(`/api/now/table/${table}`, {
      sysparm_query: encodedQuery,
      sysparm_limit: 1,
      sysparm_fields: "sys_id",
      sysparm_display_count: "true"
    });
    const total = parseInt(res.headers.get("x-total-count") || "0", 10);
    if (!Number.isFinite(total)) throw new Error("Could not read record count");
    return total;
  }

  async fetchAllRecords(table, encodedQuery, fields, onProgress, signal) {
    const rows = [];
    let offset = 0;
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const res = await this.#request(`/api/now/table/${table}`, {
        sysparm_query: encodedQuery,
        sysparm_limit: this.pageSize,
        sysparm_offset: offset,
        sysparm_fields: fields.join(","),
        sysparm_display_value: "all"
      });
      const data = await res.json();
      const batch = (data.result || []).map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r)) {
          if (v && typeof v === "object") {
            out[k] = { display_value: v.display_value ?? "", value: v.value ?? "" };
          } else {
            out[k] = v;
          }
        }
        return out;
      });
      rows.push(...batch);
      offset += batch.length;
      onProgress?.({ fetched: rows.length });
      if (batch.length < this.pageSize) break;
    }
    return rows;
  }

  async fetchTimelineEvents(sysIds, fieldNames, onProgress, signal, tableName = "incident") {
    if (!sysIds.length) return {};
    return this.#fetchViaActivity(sysIds, fieldNames, onProgress, signal, tableName);
  }

  async #fetchViaActivity(sysIds, fieldNames, onProgress, signal, tableName) {
    const A = typeof Analysis !== "undefined" ? Analysis : null;
    if (!A?.extractEventsFromListHistory && !A?.extractEventsFromActivity) {
      throw new Error("Activity parser module not loaded");
    }
    const wanted = new Set(fieldNames);
    let preloaded = null;
    if (!this.activitySource) {
      try {
        const probe = await this.#fetchListHistory(tableName, sysIds[0]);
        if (Array.isArray(probe?.entries)) {
          this.activitySource = "list-history";
          preloaded = { [sysIds[0]]: probe };
        } else {
          this.activitySource = "stream";
        }
      } catch (err) {
        this.onDiagnostic?.({
          kind: "warn",
          note: `list_history.do unavailable (${String(err.message).slice(0, 80)}) - using /api/now/v1/activity/stream`
        });
        this.activitySource = "stream";
      }
    }
    if (this.activitySource === "list-history") {
      try {
        return await this.#runListHistory(sysIds, wanted, onProgress, signal, tableName, preloaded);
      } catch (err) {
        if (signal?.aborted) throw err;
        this.onDiagnostic?.({
          kind: "warn",
          note: `list_history.do failed mid-run (${String(err.message).slice(0, 80)}) - switching to activity/stream`
        });
        this.activitySource = "stream";
      }
    }
    return await this.#runStream(sysIds, wanted, onProgress, signal, tableName);
  }

  async #runListHistory(sysIds, wanted, onProgress, signal, tableName, preloaded) {
    const byTicket = {};
    for (const [idx, sysId] of sysIds.entries()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const payload = preloaded?.[sysId] || await this.#fetchListHistory(tableName, sysId);
      const events = (Analysis.extractEventsFromListHistory(payload)[sysId] || [])
        .filter(e => wanted.has(e.field));
      if (events.length) byTicket[sysId] = events;
      onProgress?.({ ticketsDone: idx + 1, ticketsTotal: sysIds.length });
    }
    if (!Object.keys(byTicket).length && sysIds.length) {
      this.onDiagnostic?.({
        kind: "warn",
        note: "activity feed yielded no field changes; timelines will stay empty"
      });
    }
    return byTicket;
  }

  async #fetchListHistory(table, sysId) {
    const res = await this.#request("/list_history.do", {
      sysparm_type: "list_history",
      table,
      action: "get_new_entries",
      sysparm_silent_request: "true",
      sysparm_auto_request: "true",
      include_attachments: "",
      sys_id: sysId
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("non-JSON response");
    }
    if (!json || !Array.isArray(json.entries)) throw new Error("missing entries array");
    return json;
  }

  async #runStream(sysIds, wanted, onProgress, signal, tableName) {
    const parse = Analysis.extractEventsFromActivity;
    const byTicket = {};
    for (const [idx, sysId] of sysIds.entries()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let entries;
      try {
        entries = await this.#fetchActivityEntries(tableName, sysId);
      } catch (err) {
        throw new Error(
          `Activity stream unavailable (${err.message}) - no compatible activity feed endpoint on this release`
        );
      }
      const events = (parse(entries) || []).filter(e => wanted.has(e.field));
      if (events.length) byTicket[sysId] = events;
      onProgress?.({ ticketsDone: idx + 1, ticketsTotal: sysIds.length });
    }
    if (!Object.keys(byTicket).length && sysIds.length) {
      this.onDiagnostic?.({
        kind: "warn",
        note: "activity feed yielded no recognizable field changes; timelines will stay empty"
      });
    }
    return byTicket;
  }

  async #fetchActivityEntries(table, sysId) {
    const entries = [];
    for (let page = 0; page < 5; page++) {
      const res = await this.#request("/api/now/v1/activity/stream", {
        table,
        sys_id: sysId,
        sysparm_limit: 200,
        sysparm_offset: entries.length
      });
      const data = await res.json();
      const batch =
        data?.result?.entries ||
        data?.entries ||
        (Array.isArray(data?.result) ? data.result : []);
      if (!Array.isArray(batch) || !batch.length) break;
      entries.push(...batch);
      if (batch.length < 200) break;
    }
    return entries;
  }
}

if (typeof self !== "undefined") self.ServiceNowClient = ServiceNowClient;
if (typeof module !== "undefined") module.exports = { ServiceNowClient };
