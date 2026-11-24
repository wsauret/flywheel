// The graph that the rules share, the finding shape, and the circle report
// that module-cycle and tangle print. Port of deslop-please src/graph and
// src/lint/mod.rs (MIT).
import type { Model, Reference, Wrapper } from "./model.ts";

// How many names a reader holds in mind at once: the most that a finding
// lists, and the most functions that a module shows before it is shallow.
export const HELD_IN_MIND = 7;

export type LintName = "module-cycle" | "tangle" | "field-leak" | "shallow-module" | "wide-directory" | "long-file";
export const LINTS: readonly LintName[] = ["module-cycle", "tangle", "field-leak", "shallow-module", "wide-directory", "long-file"];

export interface Location {
  file: string;
  line: number;
}
export interface Step {
  member: string;
  site: Location;
  uses: string;
}
export type Picture =
  | { kind: "circle"; steps: Step[]; rest: string | null }
  | { kind: "spread"; owner: string; field: string; modules: [number, string][]; others: string[] }
  | { kind: "lists"; shown: number; hidden: number; lists: [string, number][] }
  | { kind: "bar"; label: string; length: number; most: number };

// One finding. `key` names it without a line number, so it stays the same
// while the code around it moves: the sorted members of a circle, the owner
// and name of a field, or the path of a module, directory, or file.
export interface Finding {
  lint: LintName;
  key: string;
  message: string;
  location: Location | null;
  notes: string[];
  picture: Picture;
}

// A thing is a top-level type, function, or constant, with its members.
interface Thing {
  item: number;
  home: number;
}
export interface Use {
  reference: number;
  user: number | null;
  item: number;
  through: number | null;
  copies: boolean;
}
export interface Graph {
  things: Thing[];
  thingOf: (number | null)[];
  uses: Use[];
  tangles: number[][];
  tangleOf: (number | null)[];
}

export const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareArrays = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};
type Site = [string, number];
const compareSites = (a: Site, b: Site) => compareStrings(a[0], b[0]) || a[1] - b[1];

// The strongly connected components of more than one node (Tarjan, without
// recursion), each sorted, in sorted order.
export function circles(edges: number[][]): number[][] {
  const unseen = -1;
  const n = edges.length;
  const index = Array.from({ length: n }, () => unseen);
  const low = Array.from({ length: n }, () => 0);
  const onStack = Array.from({ length: n }, () => false);
  const stack: number[] = [];
  let next = 0;
  const found: number[][] = [];
  const enter = (node: number) => {
    index[node] = next;
    low[node] = next;
    next++;
    stack.push(node);
    onStack[node] = true;
  };
  for (let start = 0; start < n; start++) {
    if (index[start] !== unseen) continue;
    const work: [number, number][] = [[start, 0]];
    enter(start);
    while (work.length) {
      const top = work.at(-1)!;
      const [node, edge] = top;
      const to = edges[node]![edge];
      if (to !== undefined) {
        top[1]++;
        if (index[to] === unseen) {
          enter(to);
          work.push([to, 0]);
        } else if (onStack[to]) low[node] = Math.min(low[node]!, index[to]!);
        continue;
      }
      work.pop();
      const parent = work.at(-1)?.[0];
      if (parent !== undefined) low[parent] = Math.min(low[parent]!, low[node]!);
      if (low[node] !== index[node]) continue;
      const component: number[] = [];
      for (let m = stack.pop(); m !== undefined; m = stack.pop()) {
        onStack[m] = false;
        component.push(m);
        if (m === node) break;
      }
      if (component.length > 1) found.push(component.sort((a, b) => a - b));
    }
  }
  return found.sort(compareArrays);
}

export function buildGraph(model: Model): Graph {
  const { tree, items, files } = model;
  const counted = (id: number) => {
    const it = items[id]!;
    return it.kind !== "module" && !tree.isTest(it.owner) && (it.file === null || !files[it.file]?.test);
  };
  const things: Thing[] = [];
  const ofRoot = new Map<number, number>();
  const thingOf: (number | null)[] = items.map(() => null);
  for (const [id] of items.entries()) {
    let root = id;
    for (let parent = items[root]!.parent; parent !== null; parent = items[root]!.parent) root = parent;
    const it = items[root]!;
    if (!["type", "function", "constant"].includes(it.kind) || !counted(id) || !counted(root)) continue;
    let t = ofRoot.get(root);
    if (t === undefined) {
      things.push({ item: root, home: it.owner });
      t = things.length - 1;
      ofRoot.set(root, t);
    }
    thingOf[id] = t;
  }
  const uses: Use[] = [];
  for (const [index, r] of model.references.entries()) {
    if (r.test || (r.holder !== null && model.wrappers.has(r.holder))) continue;
    const user = r.holder !== null ? (thingOf[r.holder] ?? null) : null;
    const through = model.wrappers.has(r.item) ? r.item : null;
    for (const [item, copies] of behind(model.wrappers, r.item, r.copies)) {
      if (thingOf[item] !== null) uses.push({ reference: index, user, item, through, copies });
    }
  }
  const knows: number[][] = things.map(() => []);
  for (const u of uses) {
    const used = thingOf[u.item] ?? null;
    if (u.user !== null && used !== null && u.user !== used) knows[u.user]!.push(used);
  }
  const tangles = circles(knows);
  const tangleOf: (number | null)[] = things.map(() => null);
  for (const [i, members] of tangles.entries()) for (const m of members) tangleOf[m] = i;
  return { things, thingOf, uses, tangles, tangleOf };
}

// The items that a use of `item` reaches through its wrappers, and whether
// each one is only read.
function behind(wrappers: Map<number, Wrapper>, item: number, refCopies: boolean): [number, boolean][] {
  const used: [number, boolean][] = [];
  for (let at = item; ; ) {
    const w = wrappers.get(at);
    if (w?.kind === "forwarder") {
      for (const f of w.fields) used.push([f, true]);
      at = w.target;
    } else if (w?.kind === "accessor") {
      for (const f of w.lent) used.push([f, refCopies]);
      for (const f of w.copied) used.push([f, true]);
      return used;
    } else {
      used.push([at, at === item && refCopies]);
      return used;
    }
  }
}

export const counted = (n: number, noun: string) => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`);
export const listed = (names: string[]) => {
  const shown = names.slice(0, HELD_IN_MIND).join(", ");
  const more = names.length - HELD_IN_MIND;
  return more > 0 ? `${shown}, +${more} more` : shown;
};
export const clickable = (l: Location) => `${l.file}:${l.line}:1`;
export const fullName = (model: Model, g: Graph, t: number) => `${model.tree.display(g.things[t]!.home)}::${model.items[g.things[t]!.item]!.name}`;

const names = (model: Model, ids: Set<number>) => [...ids].sort((a, b) => a - b).map((i) => model.items[i]!.name);

// `A::x`, `A::y`, `B` become `A::{x, y}, B`.
function grouped(ns: string[]): string {
  const groups: [string, string[]][] = [];
  for (const n of ns) {
    const at = n.indexOf("::");
    const [head, tail] = at < 0 ? [n, "self"] : [n.slice(0, at), n.slice(at + 2)];
    const group = groups.find((x) => x[0] === head);
    if (group) group[1].push(tail);
    else groups.push([head, [tail]]);
  }
  return listed(groups.map(([head, tails]) => (tails.length === 1 ? (tails[0] === "self" ? head : `${head}::${tails[0]}`) : `${head}::{${listed(tails)}}`)));
}

// The uses that tie one member of a circle to another.
export class Tie {
  items = new Set<number>();
  holders = new Set<number>();
  sites: Site[] = [];
  written = new Map<number, Site>();

  add(model: Model, item: number, r: Reference, module: number): void {
    this.items.add(item);
    if (r.holder !== null) this.holders.add(r.holder);
    const site: Site = [model.files[r.file]!.path, r.line];
    const first = this.written.get(module);
    if (!first || compareSites(site, first) < 0) this.written.set(module, site);
    if (!this.sites.some((s) => s[0] === site[0] && s[1] === site[1])) this.sites.push(site);
  }

  cost(): number {
    return this.items.size;
  }

  site(): Location {
    const [file, line] = [...this.sites].sort(compareSites)[0]!;
    return { file, line };
  }

  note(model: Model, verb: string, [user, used]: [string, string]): string {
    const site = this.site();
    const firsts = [...new Map([...this.written.values()].map((s) => [`${s[0]}:${s[1]}`, s])).values()].sort(compareSites);
    const elsewhere = firsts.filter(([f, l]) => !(f === site.file && l === site.line)).map(([file, line]) => clickable({ file, line }));
    const also = elsewhere.length ? `; also at ${listed(elsewhere)}` : "";
    return `${clickable(site)}: \`${user}\` ${verb} \`${used}\` by ${counted(this.items.size, "item")}: ${listed(names(model, this.items))}${also}`;
  }

  step(model: Model, member: string): Step {
    const uses = grouped(names(model, this.items));
    const holders = names(model, this.holders);
    return { member, site: this.site(), uses: holders.length === 1 ? `${holders[0]} uses ${uses}` : `uses ${uses}` };
  }
}

export interface CircleReport {
  location: Location | null;
  notes: string[];
  picture: Picture;
}

// The notes and the drawn circle of a circle of `members` things whose ties
// are `tiesIn`, cheapest tie first.
export function circleReport(model: Model, verb: string, noun: string, members: number, tiesIn: [[string, string], Tie][]): CircleReport {
  const ties = [...tiesIn].sort((a, b) => a[1].cost() - b[1].cost() || compareStrings(a[0][0], b[0][0]) || compareStrings(a[0][1], b[0][1]));
  const notes = ties.slice(0, HELD_IN_MIND).map(([ns, t]) => t.note(model, verb, ns));
  if (ties.length > HELD_IN_MIND) notes.push(`and ${counted(ties.length - HELD_IN_MIND, "more tie")}`);
  const circle = shortestCircle(ties.map((t) => t[0]));
  const steps = circle.map((at) => ties[at]![1].step(model, ties[at]![0][0]));
  const leftOut = (
    [
      [members - circle.length, `more ${noun}`],
      [ties.length - circle.length, "more tie"],
    ] as const
  ).filter(([c]) => c > 0).map(([c, n]) => counted(c, n));
  return {
    location: ties.length ? ties[0]![1].site() : null,
    notes,
    picture: { kind: "circle", steps, rest: leftOut.length ? `not drawn: ${leftOut.join(", ")}` : null },
  };
}

// The shortest circle through the first tie, as tie indexes in order.
export function shortestCircle(ties: [string, string][]): number[] {
  const [start, end] = ties[0]!;
  const reached = new Map<string, number | null>([[end, null]]);
  const queue = [end];
  for (let at = queue.shift(); at !== undefined && at !== start; at = queue.shift()) {
    for (const [i, [user, used]] of ties.entries()) {
      if (user !== at || reached.has(used)) continue;
      reached.set(used, i);
      queue.push(used);
    }
  }
  const circle: number[] = [];
  let at = start;
  for (let r = reached.get(at); r !== undefined && r !== null; r = reached.get(at)) {
    circle.push(r);
    at = ties[r]![0];
  }
  circle.push(0);
  circle.reverse();
  return circle;
}
