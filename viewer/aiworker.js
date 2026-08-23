import "../analysis/aiextract.js";

let Tmod = null;
let pipe = null;
let pipeModel = null;

async function getPipe(modelId, report) {
  if (!Tmod) {
    Tmod = await import("../lib/vendor/transformers.min.js");
    Tmod.env.backends.onnx.wasm.numThreads = 1;
    Tmod.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("lib/vendor/");
  }
  if (!pipe || pipeModel !== modelId) {
    pipeModel = null;
    pipe = null;
    pipe = await Tmod.pipeline("text-generation", modelId, {
      dtype: "q4f16",
      progress_callback: p => {
        if (p.status === "progress" && p.file) {
          report(p.file, Math.round(p.progress || 0));
        }
      }
    });
    pipeModel = modelId;
  }
  return pipe;
}

self.onmessage = async e => {
  const { id, type, modelId, notes } = e.data || {};
  try {
    if (type === "ensure") {
      await getPipe(modelId, (file, percent) =>
        self.postMessage({ id, type: "progress", file, percent }));
      self.postMessage({ id, ok: true });
    } else if (type === "extract") {
      if (!pipe) throw new Error("Model not loaded");
      const A = self.AiExtract;
      const messages = A.buildClosurePrompt(notes);
      const out = await pipe(messages, { max_new_tokens: 120, do_sample: false });
      const text = out[0]?.generated_text?.at(-1)?.content || "";
      const parsed = A.parseClosureJson(text);
      self.postMessage({ id, ok: true, ...parsed });
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (err) {
    pipe = null;
    pipeModel = null;
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
