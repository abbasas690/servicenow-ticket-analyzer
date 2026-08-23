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

const G = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : null;
if (G) G.AiClient = { createAiClient };
