const SOLUTION_PERMANENT = "Permanent fix";
const SOLUTION_WORKAROUND = "Workaround";

function tidyRootCause(v) {
  let s = String(v ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^root\s*ca?us?e\s*(is)?\s*[::-]?\s*/i, "").replace(/[\s.;]+$/, "");
  if (!s || /^(unknown|n\/?a|none|not specified|not mentioned|not provided)$/i.test(s)) return "";
  return s.slice(0, 300);
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
if (G) G.AiExtract = { extractHeuristic };
if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractHeuristic };
}
