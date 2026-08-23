import "../analysis/aiextract.js";

const WASM_PATH = new URL("../lib/vendor/", self.location).href;

let Tmod = null;
let pipe = null;
let pipeModel = null;
let pipeDevice = "";

function reportProgress(report) {
  return p => {
    if (p.status === "progress" && p.file) {
      report(p.file, Math.round(p.progress || 0));
    }
  };
}

async function loadRuntime() {
  if (!Tmod) {
    Tmod = await import("../lib/vendor/transformers.min.js");
    Tmod.env.backends.onnx.wasm.numThreads = 1;
    Tmod.env.backends.onnx.wasm.wasmPaths = WASM_PATH;
  }
  return Tmod;
}

async function detectDevice() {
  try {
    if (self.navigator?.gpu) {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {}
  return "wasm";
}

async function buildPipeline(device, modelId, report) {
  const T = await loadRuntime();
  const built = await T.pipeline("text-generation", modelId, {
    device,
    dtype: "q4f16",
    progress_callback: reportProgress(report)
  });
  pipe = built;
  pipeModel = modelId;
  pipeDevice = device;
  return built;
}

async function getPipe(modelId, report, forceDevice) {
  await loadRuntime();
  if (pipe && pipeModel === modelId) return pipe;
  const device = forceDevice || await detectDevice();
  return await buildPipeline(device, modelId, report);
}

const GEN_OPTS = { max_new_tokens: 72, do_sample: false };

self.onmessage = async e => {
  const { id, type, modelId, notes } = e.data || {};
  const reply = payload => self.postMessage({ id, ...payload });
  try {
    if (type === "ensure") {
      await getPipe(modelId, (file, percent) =>
        reply({ type: "progress", file, percent }));
      reply({ ok: true, device: pipeDevice });
    } else if (type === "extract") {
      if (!pipe) throw new Error("Model not loaded");
      const A = self.AiExtract;
      const messages = A.buildClosurePrompt(notes);
      let out;
      try {
        out = await pipe(messages, GEN_OPTS);
      } catch (err) {
        if (pipeDevice !== "webgpu") throw err;
        try { await pipe.dispose(); } catch {}
        pipe = null;
        pipeModel = null;
        await getPipe(modelId, () => {}, "wasm");
        out = await pipe(messages, GEN_OPTS);
      }
      const text = out[0]?.generated_text?.at(-1)?.content || "";
      reply({ ok: true, ...A.parseClosureJson(text) });
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (err) {
    reply({ ok: false, error: String(err?.message || err) });
  }
};
