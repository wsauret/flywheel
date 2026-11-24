// Prints findings the way deslop-please does (src/format, MIT): the message,
// the location, the notes, and a picture of the finding.
import { HELD_IN_MIND, type Finding, type Picture } from "./graph.ts";

const BAR = 40;
const width = (s: string) => [...s].length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));
const padLeft = (s: string, w: number) => " ".repeat(Math.max(0, w - width(s))) + s;

export function renderFinding(f: Finding): string {
  let out = `error[${f.lint}]: ${f.message}\n`;
  if (f.location) out += f.location.line > 0 ? `  --> ${f.location.file}:${f.location.line}:1\n` : `  --> ${f.location.file}\n`;
  for (const n of f.notes) out += `  = note: ${n}\n`;
  for (const l of draw(f.picture)) out += `    ${l}\n`;
  return `${out}\n`;
}

function draw(p: Picture): string[] {
  if (p.kind === "circle") return drawCircle(p);
  if (p.kind === "spread") return drawSpread(p);
  return drawBars(p);
}

function drawCircle(p: Extract<Picture, { kind: "circle" }>): string[] {
  const dirs = p.steps.map((s) => s.site.file.split("/").slice(0, -1));
  let common = dirs[0] ?? [];
  for (const d of dirs) {
    let same = 0;
    while (same < common.length && common[same] === d[same]) same++;
    common = common.slice(0, same);
  }
  const skip = common.reduce((s, x) => s + x.length + 1, 0);
  const sites = p.steps.map((s) => `${s.site.file.slice(skip)}:${s.site.line}`);
  const siteWidth = Math.max(0, ...sites.map((s) => s.length));
  const lines: string[] = [];
  for (const [i, s] of p.steps.entries()) {
    lines.push(`${i === 0 ? "┌─▶ " : "│   "}${s.member}`, `│     ${i === 0 ? "┃" : "│"} ${pad(sites[i]!, siteWidth)}  ${s.uses}`);
    if (i + 1 < p.steps.length) lines.push("│     ▼");
  }
  lines.push("└─────┘");
  if (p.rest) lines.push(p.rest);
  return lines;
}

function drawSpread(p: Extract<Picture, { kind: "spread" }>): string[] {
  const lines = [p.owner];
  const digits = Math.max(0, ...p.modules.map(([c]) => String(c).length));
  const under = " ".repeat(width(p.field) + 3);
  for (const [i, [c, m]] of p.modules.entries()) {
    let lead = under;
    let arm = "  ┣━";
    if (i === 0) {
      lead = `  ${p.field} `;
      arm = p.modules.length === 1 ? "◀━━━" : "◀━┳━";
    } else if (i + 1 === p.modules.length) arm = "  ┗━";
    lines.push(`${lead}${arm} ${padLeft(String(c), digits)}  ${m}`);
  }
  for (const o of p.others) lines.push(`  ${o}`);
  return lines;
}

function drawBars(p: Extract<Picture, { kind: "lists" | "bar" }>): string[] {
  const rows: [string, number][] = p.kind === "lists" ? [["shows", p.shown], ["hides", p.hidden], ...p.lists] : [[p.label, p.length]];
  const most = p.kind === "lists" ? HELD_IN_MIND : p.most;
  const unit = Math.max(1, Math.ceil(most / (BAR / 2)));
  const line = Math.ceil(most / unit);
  const nameWidth = Math.max(0, ...rows.map(([n]) => width(n)));
  const lines = [`${" ".repeat(nameWidth)}  ${padLeft(String(most), line + 1)}`];
  for (const [name, length] of rows) {
    const cells = Math.ceil(length / unit);
    const inside = Math.min(cells, line);
    const past = cells - inside;
    let beyond = "█".repeat(Math.min(past, BAR - line));
    if (past > BAR - line) beyond += "⋯";
    lines.push(`${pad(name, nameWidth)}  ${"█".repeat(inside)}${" ".repeat(line - inside)}│${beyond} ${length}`);
  }
  return lines;
}
