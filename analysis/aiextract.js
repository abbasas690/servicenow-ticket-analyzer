const AI_MODELS = [
  {
    id: "onnx-community/Qwen2.5-0.5B-Instruct",
    label: "Qwen2.5 0.5B - fastest (~500 MB)"
  },
  {
    id: "onnx-community/Llama-3.2-1B-Instruct-q4f16",
    label: "Llama 3.2 1B - balanced (~900 MB)"
  },
  {
    id: "onnx-community/SmolLM2-1.7B-Instruct-q4f16",
    label: "SmolLM2 1.7B - best quality (~1.6 GB)"
  }
];

const SOLUTION_PERMANENT = "Permanent fix";
const SOLUTION_WORKAROUND = "Workaround";

function buildClosurePrompt(notes) {
  const clean = String(notes || "").trim().slice(0, 4000);
  return [
    {
      role: "system",
      content:
        "You extract structured data from ITSM ticket closure notes. " +
        'Reply with ONLY a JSON object of the form {"solution_type":"...","root_cause":"..."}. No other text.'
    },
    {
      role: "user",
      content:
        "Closure notes:\n\"\"\"\n" + clean + "\n\"\"\"\n\n" +
        "Classify solution_type as exactly one of \"Permanent fix\" or \"Workaround\". " +
        "If the notes do not say whether the fix is permanent, decide from context: " +
        "a real defect fixed at its source is permanent; monitoring, restarting, deferring or manual cleanup is a workaround. " +
        "Summarize root_cause in one short sentence (max 20 words); use \"Unknown\" only if truly absent. " +
        "Reply with only the JSON object."
    }
  ];
}

function classifySolution(v) {
  const s = String(v || "").toLowerCase();
  if (!s) return "";
  if (/permanent|permanant|permenant|fixed properly|root fix|defect was fixed/.test(s)) return SOLUTION_PERMANENT;
  if (/work\s*around|workaround|temporary|temp fix|not permanent|manual/.test(s)) return SOLUTION_WORKAROUND;
  return "";
}

function firstBalancedJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === "\"") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tidyRootCause(v) {
  let s = String(v ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^root\s*ca?us?e\s*(is)?\s*[::-]?\s*/i, "").replace(/[\s.;]+$/, "");
  if (!s || /^(unknown|n\/?a|none|not specified|not mentioned|not provided)$/i.test(s)) return "";
  return s.slice(0, 300);
}

function parseClosureJson(text) {
  const raw = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "");
  const out = { solutionType: "", rootCause: "" };
  const jsonText = firstBalancedJson(raw);
  let obj = null;
  if (jsonText) {
    try { obj = JSON.parse(jsonText); } catch { obj = null; }
  }
  if (!obj) {
    const sm = raw.match(/solution[_\s-]?type["'\s:=]+(permanent[^"'{},]*|work\s*-?\s*around[^"'{},]*)/i);
    const rm = raw.match(/root\s*_?\s*ca?us?e["'\s:=]+((?:"([^"]*)")|([^,}\n]{3,}))/i);
    if (sm) out.solutionType = classifySolution(sm[1]);
    if (rm) out.rootCause = tidyRootCause(rm[2] || rm[3]);
    return out;
  }
  const st = obj.solution_type ?? obj.solutionType ?? obj.type ?? "";
  out.solutionType = classifySolution(st) ||
    (/true/i.test(String(obj.is_permanent ?? "")) ? SOLUTION_PERMANENT
      : /false/i.test(String(obj.is_permanent ?? "")) ? SOLUTION_WORKAROUND : "");
  out.rootCause = tidyRootCause(obj.root_cause ?? obj.rootCause ?? obj.cause ?? "");
  return out;
}

function extractHeuristic(notes) {
  const text = String(notes || "");
  const out = { solutionType: "", rootCause: "" };
  if (!text.trim()) return out;

  const ynLine = text.match(/^.*\bpermanent\b[^.\n]*?\b(yes|no|true|false)\b[^0-9]*$/im);
  if (ynLine) {
    out.solutionType = /yes|true/i.test(ynLine[1]) ? SOLUTION_PERMANENT : SOLUTION_WORKAROUND;
  }

  if (!out.solutionType) {
    if (/\bpermanen(?:t|tly)\s+(?:fix|resolved|solution)|\bfixed\s+(?:at\s+)?(?:the\s+)?root\b|\bpermanent\s+solution\s+applied\b/i.test(text)) {
      out.solutionType = SOLUTION_PERMANENT;
    } else if (/\bwork\s?-?arounds?\b|\btemporary\b|\btemp\s+fix\b|\buntil\s+(?:the\s+)?(?:vendor|patch)\b/i.test(text)) {
      out.solutionType = SOLUTION_WORKAROUND;
    }
  }

  const rm = text.match(/(?:root\s*cause|rca)\s*[:\-]\s*([^\n]+)/i)
    || text.match(/\broot\s*cause\s+(?:was|is)\s+([^\n.!]+)/i);
  if (rm) out.rootCause = tidyRootCause(rm[1]);
  return out;
}

const G = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : null;
if (G) G.AiExtract = { AI_MODELS, buildClosurePrompt, parseClosureJson, classifySolution, extractHeuristic };
if (typeof module !== "undefined" && module.exports) {
  module.exports = { AI_MODELS, buildClosurePrompt, parseClosureJson, classifySolution, extractHeuristic };
}
