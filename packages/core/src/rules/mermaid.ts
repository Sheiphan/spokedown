// Mermaid diagrams: announce type and size. (A "labels" mode that reads node text comes later.)
import { numberToWords, type NumberOptions } from "../numbers.js";

const TYPES: [RegExp, string][] = [
  [/^(flowchart|graph)\b/, "flowchart"],
  [/^sequenceDiagram\b/, "sequence diagram"],
  [/^classDiagram/, "class diagram"],
  [/^stateDiagram/, "state diagram"],
  [/^erDiagram\b/, "entity relationship diagram"],
  [/^gantt\b/, "Gantt chart"],
  [/^pie\b/, "pie chart"],
  [/^mindmap\b/, "mind map"],
  [/^timeline\b/, "timeline"],
  [/^journey\b/, "user journey"],
  [/^gitGraph\b/, "git graph"],
  [/^(xychart|quadrantChart|sankey)/, "chart"],
  [/^(block|architecture)/, "architecture diagram"],
];

const KEYWORDS = /^(subgraph|end|style|classDef|class|click|linkStyle|direction|%%)/;

export function countFlowchartNodes(code: string): number {
  // drop quoted labels (may span lines), then bracketed shapes and edge labels
  let s = code.replace(/"[^"]*"/g, "");
  for (let i = 0; i < 3; i++) s = s.replace(/\[[^\[\]]*\]|\([^()]*\)|\{[^{}]*\}|\|[^|]*\|/g, " ");
  const ids = new Set<string>();
  for (const raw of s.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line || KEYWORDS.test(line)) continue;
    for (const part of line.split(/<?[-=.]{2,}[->ox]?|~~~|&|;/)) {
      const m = /^\s*([A-Za-z_][\w]*)\s*(?:@\{.*\})?\s*>?$/.exec(part);
      if (m) ids.add(m[1]!);
    }
  }
  return ids.size;
}

function countParticipants(code: string): number {
  const ids = new Set<string>();
  for (const line of code.split("\n").slice(1)) {
    const p = /^\s*(?:participant|actor)\s+(\S+)/.exec(line);
    if (p) ids.add(p[1]!);
    const msg = /^\s*([\w]+)\s*-?-[>x)]+[+-]?\s*([\w]+)\s*:/.exec(line);
    if (msg) ids.add(msg[1]!).add(msg[2]!);
  }
  return ids.size;
}

export function describeMermaid(code: string, opts: NumberOptions): string[] {
  const first = code.trim().split("\n")[0]?.trim() ?? "";
  const type = TYPES.find(([re]) => re.test(first))?.[1] ?? "diagram";
  const words = ["Diagram:", ...type.split(" ")];
  if (type === "flowchart") {
    const n = countFlowchartNodes(code);
    if (n) words.push("with", ...numberToWords(String(n), opts, false), n === 1 ? "step" : "steps");
  } else if (type === "sequence diagram") {
    const n = countParticipants(code);
    if (n) words.push("with", ...numberToWords(String(n), opts, false), n === 1 ? "participant" : "participants");
  }
  words[words.length - 1] += ".";
  return words;
}
