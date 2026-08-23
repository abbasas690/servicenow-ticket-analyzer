class ServiceNowClient {
  constructor(instanceUrl, options = {}) {
    this.baseUrl = instanceUrl.replace(/\/+$/, "");
    this.transport = options.transport || null;
    this.onDiagnostic = options.onDiagnostic || null;
    this.pageSize = 1000;
    this.auditBatchSize = 80;
    this.maxRetries = 4;
    this.debugResponses = false;
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
          table: params.sysparm_query && /^sys_audit/.test(q) ? "sys_audit" : undefined,
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

  async fetchChoices(table, element) {
    const res = await this.#request("/api/now/table/sys_choice", {
      sysparm_query: `name=${table}^element=${element}^inactive=false`,
      sysparm_limit: 100,
      sysparm_fields: "value,label"
    });
    const data = await res.json();
    return (data.result || []).map(c => ({ value: c.value, label: c.label }));
  }

  async fetchStateMap(table) {
    const t = table || "incident";
    let choices = await this.fetchChoices(t, "state");
    if (choices.length === 0 && t !== "task") {
      choices = await this.fetchChoices("task", "state");
    }
    const map = {};
    for (const c of choices) map[c.value] = c.label;
    return map;
  }

  async resolveGroup(groupName) {
    const res = await this.#request("/api/now/table/sys_user_group", {
      sysparm_query: `name=${groupName}`,
      sysparm_limit: 2,
      sysparm_fields: "sys_id,name"
    });
    const data = await res.json();
    const groups = data.result || [];
    if (groups.length === 0) throw new Error(`Assignment group not found: "${groupName}"`);
    return groups[0];
  }

  async resolveGroups(names) {
    const list = (names || []).map(n => String(n).trim()).filter(Boolean);
    if (!list.length) throw new Error("No groups selected");
    const uniq = [...new Set(list)];
    const query = uniq.map(n => `name=${n}`).join("^OR");
    const res = await this.#request("/api/now/table/sys_user_group", {
      sysparm_query: query,
      sysparm_limit: String(uniq.length),
      sysparm_fields: "sys_id,name"
    });
    const data = await res.json();
    const found = data.result || [];
    const norm = s => String(s).toLowerCase();
    const missing = uniq.filter(n => !found.some(g => norm(g.name) === norm(n)));
    if (missing.length === uniq.length) {
      throw new Error(`Assignment group(s) not found: ${missing.join(", ")}`);
    }
    return uniq
      .map(n => found.find(g => norm(g.name) === norm(n)))
      .filter(Boolean);
  }

  async fetchGroupMembers(groupSysId) {
    const members = [];
    let offset = 0;
    while (true) {
      const res = await this.#request("/api/now/table/sys_user_grmember", {
        sysparm_query: `group=${groupSysId}`,
        sysparm_limit: this.pageSize,
        sysparm_offset: offset,
        sysparm_fields: "user"
      });
      const data = await res.json();
      const batch = data.result || [];
      for (const m of batch) {
        if (m.user?.value) members.push(m.user.value);
      }
      offset += batch.length;
      if (batch.length < this.pageSize) break;
    }
    if (members.length === 0) throw new Error("Group has no members");
    return members;
  }

  async fetchMemberMap(groupSysIds) {
    const ids = [...new Set((groupSysIds || []).filter(Boolean))];
    if (!ids.length) return {};
    const map = {};
    for (const id of ids) map[id] = [];
    let offset = 0;
    while (true) {
      const res = await this.#request("/api/now/table/sys_user_grmember", {
        sysparm_query: `groupIN${ids.join(",")}`,
        sysparm_limit: this.pageSize,
        sysparm_offset: offset,
        sysparm_fields: "group,user"
      });
      const data = await res.json();
      const batch = data.result || [];
      for (const m of batch) {
        const gid = m.group?.value;
        const uid = m.user?.value;
        if (gid && uid && gid in map) map[gid].push(uid);
      }
      offset += batch.length;
      if (batch.length < this.pageSize) break;
    }
    return map;
  }

  async fetchUsersByIds(sysIds) {
    const ids = [...new Set((sysIds || []).filter(Boolean))];
    if (!ids.length) return [];
    const users = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await this.#request("/api/now/table/sys_user", {
        sysparm_query: `sys_idIN${chunk.join(",")}`,
        sysparm_limit: this.pageSize,
        sysparm_fields: "sys_id,name"
      });
      const data = await res.json();
      for (const u of data.result || []) {
        if (u.sys_id && u.name) users.push({ sysId: u.sys_id, name: u.name });
      }
    }
    return users;
  }

  async resolveUserNames(names) {
    const list = [...new Set((names || []).map(s => String(s).trim()).filter(Boolean))];
    if (!list.length) return [];
    const seen = new Set();
    const users = [];
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      const res = await this.#request("/api/now/table/sys_user", {
        sysparm_query: `user_nameIN${chunk.join(",")}^ORnameIN${chunk.join(",")}`,
        sysparm_limit: 500,
        sysparm_fields: "sys_id,name"
      });
      const data = await res.json();
      for (const u of data.result || []) {
        if (u.sys_id && u.name && !seen.has(u.sys_id)) {
          seen.add(u.sys_id);
          users.push({ sysId: u.sys_id, name: u.name });
        }
      }
    }
    return users;
  }

  async fetchUserGroups(userSysId) {
    const res = await this.#request("/api/now/table/sys_user_grmember", {
      sysparm_query: `user=${userSysId}`,
      sysparm_limit: 200,
      sysparm_fields: "group",
      sysparm_display_value: "true",
      sysparm_exclude_reference_link: "true"
    });
    const data = await res.json();
    return [...new Set((data.result || []).map(r => r.group?.display_value || r.group).filter(Boolean))];
  }

  async findUserIdByUsername(userName) {
    const res = await this.#request("/api/now/table/sys_user", {
      sysparm_query: `user_name=${userName}`,
      sysparm_limit: 1,
      sysparm_fields: "sys_id"
    });
    const data = await res.json();
    const row = (data.result || [])[0];
    if (!row) throw new Error(`Could not resolve logged-in user "${userName}"`);
    return row.sys_id?.value || row.sys_id;
  }

  async fetchAudit(sysIds, fieldNames, onProgress, signal, tableName = "incident") {
    if (!sysIds.length) return {};
    if (this.auditSource === "history-batched" || this.auditSource === "history-perTicket") {
      return this.#fetchViaHistory(sysIds, fieldNames, onProgress, signal, tableName);
    }
    if (this.auditSource === "audit-perTicket") {
      const perTicket = await this.#fetchAuditPerTicket(sysIds, fieldNames, onProgress, signal, tableName);
      if (Object.keys(perTicket).length) return perTicket;
      return this.#fetchViaHistory(sysIds, fieldNames, onProgress, signal, tableName);
    }
    const byTicket = await this.#fetchAuditBatched(sysIds, fieldNames, onProgress, signal, tableName);
    if (Object.keys(byTicket).length) {
      this.auditSource = "audit-batched";
      return byTicket;
    }
    const probe = await this.#fetchAuditOne(sysIds[0], fieldNames, tableName, 1);
    if (!probe.length) {
      this.onDiagnostic?.({
        kind: "warn",
        note: `sys_audit returned no rows even per-ticket - switching to sys_history_line for ${sysIds.length} tickets`
      });
      return this.#fetchViaHistory(sysIds, fieldNames, onProgress, signal, tableName);
    }
    this.auditInBlocked = true;
    this.onDiagnostic?.({
      kind: "warn",
      note: `instance rejected batched audit queries (documentkeyIN) - falling back to per-ticket reads for ${sysIds.length} tickets`
    });
    const perTicket = await this.#fetchAuditPerTicket(sysIds, fieldNames, onProgress, signal, tableName);
    this.auditSource = "audit-perTicket";
    if (Object.keys(perTicket).length) return perTicket;
    return this.#fetchViaHistory(sysIds, fieldNames, onProgress, signal, tableName);
  }

  async #fetchAuditBatched(sysIds, fieldNames, onProgress, signal, tableName) {
    const byTicket = {};
    const batches = [];
    for (let i = 0; i < sysIds.length; i += this.auditBatchSize) {
      batches.push(sysIds.slice(i, i + this.auditBatchSize));
    }
    for (const [batchIndex, batch] of batches.entries()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let offset = 0;
      const wanted = new Set(batch);
      while (true) {
        const res = await this.#request("/api/now/table/sys_audit", {
          sysparm_query:
            `tablename=${tableName}^documentkeyIN${batch.join(",")}` +
            `^fieldnameIN${fieldNames.join(",")}`,
          sysparm_limit: this.pageSize,
          sysparm_offset: offset,
          sysparm_fields: "documentkey,fieldname,oldvalue,newvalue,sys_created_on",
          sysparm_display_value: "false"
        });
        const data = await res.json();
        const rows = data.result || [];
        for (const r of rows) {
          const key = r.documentkey?.value || r.documentkey;
          if (!wanted.has(key)) continue;
          (byTicket[key] ||= []).push({
            field: r.fieldname?.value || r.fieldname,
            oldValue: r.oldvalue?.value ?? r.oldvalue ?? "",
            newValue: r.newvalue?.value ?? r.newvalue ?? "",
            at: r.sys_created_on?.value || r.sys_created_on
          });
        }
        offset += rows.length;
        onProgress?.({ batchesDone: batchIndex + 1, batchesTotal: batches.length });
        if (rows.length < this.pageSize) break;
      }
    }
    return byTicket;
  }

  async #fetchAuditOne(sysId, fieldNames, tableName, limit) {
    const res = await this.#request("/api/now/table/sys_audit", {
      sysparm_query:
        `tablename=${tableName}^documentkey=${sysId}^fieldnameIN${fieldNames.join(",")}`,
      sysparm_limit: limit,
      sysparm_offset: 0,
      sysparm_fields: "documentkey,fieldname,oldvalue,newvalue,sys_created_on",
      sysparm_display_value: "false"
    });
    const data = await res.json();
    return data.result || [];
  }

  async #fetchAuditPerTicket(sysIds, fieldNames, onProgress, signal, tableName) {
    const byTicket = {};
    for (const [idx, sysId] of sysIds.entries()) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let offset = 0;
      while (true) {
        const rows = await this.#fetchAuditOnePage(sysId, fieldNames, tableName, offset);
        for (const r of rows) {
          (byTicket[sysId] ||= []).push({
            field: r.fieldname?.value || r.fieldname,
            oldValue: r.oldvalue?.value ?? r.oldvalue ?? "",
            newValue: r.newvalue?.value ?? r.newvalue ?? "",
            at: r.sys_created_on?.value || r.sys_created_on
          });
        }
        offset += rows.length;
        if (rows.length < this.pageSize) break;
      }
      onProgress?.({ ticketsDone: idx + 1, ticketsTotal: sysIds.length });
    }
    return byTicket;
  }

  async #fetchAuditOnePage(sysId, fieldNames, tableName, offset) {
    const res = await this.#request("/api/now/table/sys_audit", {
      sysparm_query:
        `tablename=${tableName}^documentkey=${sysId}^fieldnameIN${fieldNames.join(",")}`,
      sysparm_limit: this.pageSize,
      sysparm_offset: offset,
      sysparm_fields: "documentkey,fieldname,oldvalue,newvalue,sys_created_on",
      sysparm_display_value: "false"
    });
    const data = await res.json();
    return data.result || [];
  }

  async #fetchViaHistory(sysIds, fieldNames, onProgress, signal, tableName) {
    if (this.auditSource === "history-perTicket") {
      return this.#fetchHistoryPerTicket(sysIds, fieldNames, onProgress);
    }
    const batched = await this.#fetchHistoryBatched(sysIds, fieldNames);
    if (Object.keys(batched).length) {
      this.auditSource = "history-batched";
      return batched;
    }
    const probe = await this.#fetchHistoryOne(sysIds[0], fieldNames, 1);
    if (!probe.length) {
      this.onDiagnostic?.({ kind: "warn", note: "no history rows available for these tickets either; timelines will stay empty" });
      this.auditSource = this.auditSource || "history-batched";
      return {};
    }
    this.onDiagnostic?.({
      kind: "warn",
      note: `sys_history_line batched queries rejected too - reading per ticket (${sysIds.length} tickets)`
    });
    this.auditSource = "history-perTicket";
    return this.#fetchHistoryPerTicket(sysIds, fieldNames, onProgress);
  }

  async #fetchHistoryBatched(sysIds, fieldNames) {
    const byTicket = {};
    const batches = [];
    for (let i = 0; i < sysIds.length; i += this.auditBatchSize) {
      batches.push(sysIds.slice(i, i + this.auditBatchSize));
    }
    for (const batch of batches) {
      let offset = 0;
      while (true) {
        const res = await this.#request("/api/now/table/sys_history_line", {
          sysparm_query: `idIN${batch.join(",")}^fieldIN${fieldNames.join(",")}`,
          sysparm_limit: this.pageSize,
          sysparm_offset: offset,
          sysparm_fields: "id,field,old,new,old_value,new_value,update_time,sys_created_on",
          sysparm_display_value: "false"
        });
        const data = await res.json();
        const rows = data.result || [];
        for (const r of rows) {
          const key = r.id?.value || r.id;
          if (!byTicket[key]) byTicket[key] = [];
          byTicket[key].push(this.#historyEvent(r));
        }
        offset += rows.length;
        if (rows.length < this.pageSize) break;
      }
    }
    return byTicket;
  }

  #historyEvent(r) {
    const pick = (...vals) => {
      for (const v of vals) {
        const s = v === null || v === undefined ? "" : String(v?.value ?? v).trim();
        if (s) return s;
      }
      return "";
    };
    return {
      field: r.field?.value || r.field || "",
      oldValue: pick(r.old_value, r.old),
      newValue: pick(r.new_value, r.new),
      at: pick(r.update_time, r.sys_created_on)
    };
  }

  async #fetchHistoryOne(sysId, fieldNames, limit) {
    const res = await this.#request("/api/now/table/sys_history_line", {
      sysparm_query: `id=${sysId}^fieldIN${fieldNames.join(",")}`,
      sysparm_limit: limit,
      sysparm_offset: 0,
      sysparm_fields: "id,field,old,new,old_value,new_value,update_time,sys_created_on",
      sysparm_display_value: "false"
    });
    const data = await res.json();
    return data.result || [];
  }

  async #fetchHistoryPerTicket(sysIds, fieldNames, onProgress) {
    const byTicket = {};
    for (const [idx, sysId] of sysIds.entries()) {
      let offset = 0;
      while (true) {
        const res = await this.#request("/api/now/table/sys_history_line", {
          sysparm_query: `id=${sysId}^fieldIN${fieldNames.join(",")}`,
          sysparm_limit: this.pageSize,
          sysparm_offset: offset,
          sysparm_fields: "id,field,old,new,old_value,new_value,update_time,sys_created_on",
          sysparm_display_value: "false"
        });
        const data = await res.json();
        const rows = data.result || [];
        for (const r of rows) {
          (byTicket[sysId] ||= []).push(this.#historyEvent(r));
        }
        offset += rows.length;
        if (rows.length < this.pageSize) break;
      }
      onProgress?.({ ticketsDone: idx + 1, ticketsTotal: sysIds.length });
    }
    return byTicket;
  }
}

if (typeof self !== "undefined") self.ServiceNowClient = ServiceNowClient;
if (typeof module !== "undefined") module.exports = { ServiceNowClient };
