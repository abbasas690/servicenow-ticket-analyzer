function createAiClient() {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function spawn() {
    worker = new Worker(chrome.runtime.getURL("viewer/aiworker.js"), { type: "module" });
    worker.onmessage = e => {
      const m = e.data || {};
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") {
        p.onProgress?.(m);
        return;
      }
      pending.delete(m.id);
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.error || "AI worker error"));
    };
    worker.onerror = e => {
      const err = new Error(e.message || "AI worker crashed");
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      try { worker.terminate(); } catch {}
      worker = null;
    };
    return worker;
  }

  function call(msg, onProgress) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject, onProgress });
      try {
        (worker || spawn()).postMessage({ id, ...msg });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  function killAll(reason) {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
    if (worker) {
      try { worker.terminate(); } catch {}
      worker = null;
    }
  }

  return {
    ensure(modelId, onProgress) {
      return call({ type: "ensure", modelId }, onProgress);
    },
    extract(notes) {
      return call({ type: "extract", notes });
    },
    stop(reason = "Stopped") {
      if (worker) killAll(reason);
    },
    dispose() {
      if (worker) killAll("AI client disposed");
    }
  };
}

function createAiPool(size) {
  const slots = Array.from({ length: Math.max(1, size) }, () => ({
    client: createAiClient(),
    busy: false
  }));
  const waiters = [];

  function acquire() {
    return new Promise((resolve, reject) => {
      const s = slots.find(x => !x.busy);
      if (s) {
        s.busy = true;
        resolve(s);
      } else {
        waiters.push({ resolve, reject });
      }
    });
  }

  function release(s) {
    const w = waiters.shift();
    if (w) w.resolve(s);
    else s.busy = false;
  }

  function killSlots(reason) {
    for (const s of slots) s.client.dispose();
    for (const w of waiters.splice(0)) w.reject(new Error(reason));
  }

  return {
    get size() {
      return slots.length;
    },
    async ensure(modelId, onProgress) {
      let device = "";
      await Promise.all(slots.map(async (s, i) => {
        s.busy = true;
        try {
          const r = await s.client.ensure(modelId, i === 0 ? onProgress : undefined);
          if (!device) device = r.device || "";
        } finally {
          release(s);
        }
      }));
      return { device };
    },
    extract(notes) {
      return acquire().then(async s => {
        try {
          return await s.client.extract(notes);
        } finally {
          release(s);
        }
      });
    },
    async map(items, fn) {
      let next = 0;
      const runners = Array.from({ length: Math.min(slots.length, items.length) }, async () => {
        while (next < items.length) {
          const idx = next++;
          await fn(items[idx], idx);
        }
      });
      await Promise.all(runners);
    },
    stop(reason = "Stopped") {
      killSlots(reason);
    },
    dispose() {
      killSlots("AI client disposed");
    }
  };
}

(globalThis ?? self).AiClient = { createAiClient, createAiPool };
