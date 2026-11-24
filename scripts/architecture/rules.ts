// The six architecture rules, pure functions of the model. Port of
// deslop-please src/lint (MIT), with the TypeScript decisions of
// ARCH-STRUCTURE-045: a type-only reference is no module-cycle link, a tangle
// needs a value link and two modules, and field-leak counts only writes,
// mutating calls, and escapes of mutable values.
import {
  HELD_IN_MIND, LINTS, Tie, buildGraph, circleReport, circles, clickable, compareStrings, counted, fullName, listed,
  type Finding, type Graph, type Location, type Use,
} from "./graph.ts";
import type { Model, SourceFile, Tree } from "./model.ts";

// A module is shallow when it shows more functions than it hides.
const BREAK_EVEN = 1;
const MOST_MEMBERS = 15;
const MOST_LINES = 2000;

interface CircleTie {
  user: number;
  used: number;
  tie: Tie;
}

// Every finding of the six rules, in rule order, then by key.
export function check(model: Model): Finding[] {
  const g = buildGraph(model);
  const all = [...moduleCycles(model), ...tangles(model, g), ...leaks(model, g), ...shallowModules(model, g), ...layoutFindings(model.files)];
  return all.sort((a, b) => LINTS.indexOf(a.lint) - LINTS.indexOf(b.lint) || compareStrings(a.key, b.key));
}

// module-cycle: sibling modules that use each other in a circle through
// value references. A type-only reference ties nothing at run time.
export function moduleCycles(model: Model): Finding[] {
  const { tree } = model;
  const ties = new Map<number, Map<string, CircleTie>>();
  for (const r of model.references) {
    if (r.test || r.typeOnly) continue;
    const it = model.items[r.item]!;
    if (it.kind === "module" || tree.isTest(it.owner) || (it.file !== null && model.files[it.file]?.test)) continue;
    const s = siblings(tree, r.from, it.owner);
    if (!s) continue;
    const [parent, user, used] = s;
    const byParent = ties.get(parent) ?? new Map<string, CircleTie>();
    ties.set(parent, byParent);
    const key = `${user},${used}`;
    const e = byParent.get(key) ?? { user, used, tie: new Tie() };
    byParent.set(key, e);
    e.tie.add(model, r.item, r, user);
  }
  const out: Finding[] = [];
  for (const [parent, byParent] of ties) {
    const children = [...new Set([...byParent.values()].flatMap((e) => [e.user, e.used]))].sort((a, b) => a - b);
    const place = (c: number) => children.indexOf(c);
    const edges: number[][] = children.map(() => []);
    for (const e of byParent.values()) edges[place(e.user)]!.push(place(e.used));
    for (const c of circles(edges)) {
      const members = c.map((at) => children[at]!);
      const name = (m: number) => tree.node(m).name;
      const inside: [[string, string], Tie][] = [...byParent.values()]
        .filter((e) => members.includes(e.user) && members.includes(e.used))
        .map((e) => [[name(e.user), name(e.used)], e.tie]);
      const report = circleReport(model, "uses", "module", members.length, inside);
      out.push({
        lint: "module-cycle",
        key: members.map((m) => tree.display(m)).sort(compareStrings).join(","),
        message: `${counted(members.length, "module")} in \`${tree.display(parent)}\` use each other in a circle`,
        location: report.location,
        notes: [`members: ${listed(members.map(name).sort(compareStrings))}`, ...report.notes],
        picture: report.picture,
      });
    }
  }
  return out;
}

// The common parent of two modules and the child of it that holds each, or
// null when one holds the other or they share only the workspace.
export function siblings(tree: Tree, a: number, b: number): [number, number, number] | null {
  const parent = tree.commonAncestor(a, b);
  if (parent === a || parent === b || tree.node(parent).kind === "workspace") return null;
  const child = (of: number) => {
    for (const n of tree.ancestors(of)) if (tree.parent(n) === parent) return n;
    return null;
  };
  const ca = child(a);
  const cb = child(b);
  return ca === null || cb === null ? null : [parent, ca, cb];
}

// tangle: things that know each other in a circle across modules, with at
// least one value link in the circle.
export function tangles(model: Model, g: Graph): Finding[] {
  const written = g.tangles.map((members) => ({
    modules: new Set(members.map((m) => g.things[m]!.home)),
    valueLinks: 0,
    ties: new Map<string, CircleTie>(),
  }));
  for (const u of g.uses) {
    if (u.user === null) continue;
    const used = g.thingOf[u.item] ?? null;
    if (used === null) continue;
    const t = g.tangleOf[u.user] ?? null;
    if (t === null || u.user === used || g.tangleOf[used] !== t) continue;
    const r = model.references[u.reference]!;
    const w = written[t]!;
    w.modules.add(r.from);
    if (!r.typeOnly) w.valueLinks++;
    const key = `${u.user},${used}`;
    const e = w.ties.get(key) ?? { user: u.user, used, tie: new Tie() };
    w.ties.set(key, e);
    e.tie.add(model, u.item, r, r.from);
  }
  const out: Finding[] = [];
  for (const [i, w] of written.entries()) {
    const members = g.tangles[i]!;
    // Recursion inside one module is that module's own cohesion; a circle is a
    // tangle when it makes the reader hold several modules at once.
    if (w.modules.size < 2) continue;
    // Things tied only through types are a recursive data definition; code in
    // the circle (a call, a construction, a value read) makes it a tangle.
    if (w.valueLinks === 0) continue;
    const ns = members.map((m) => fullName(model, g, m)).sort(compareStrings);
    const ties: [[string, string], Tie][] = [...w.ties.values()].map((e) => [[fullName(model, g, e.user), fullName(model, g, e.used)], e.tie]);
    const report = circleReport(model, "knows", "thing", members.length, ties);
    const modules = [...w.modules].map((m) => model.tree.display(m)).sort(compareStrings);
    out.push({
      lint: "tangle",
      key: ns.join(","),
      message: `${ns.length} things know each other in a circle, across ${counted(modules.length, "module")}`,
      location: report.location,
      notes: [`members: ${listed(ns)}`, `written in: ${listed(modules)}`, ...report.notes],
      picture: report.picture,
    });
  }
  return out;
}

// field-leak: a field of a type with working methods that outside code
// writes, mutates, or lets a mutable value of escape, while the type keeps
// another field to itself.
export function leaks(model: Model, g: Graph): Finding[] {
  const { items, tree } = model;
  const fields = new Map<number, number[]>();
  for (const [i, it] of items.entries()) {
    const t = g.thingOf[i] ?? null;
    if (it.kind !== "field" || it.parent === null || items[it.parent]?.kind !== "type" || it.holdsNothing || t === null) continue;
    const list = fields.get(t) ?? [];
    list.push(i);
    fields.set(t, list);
  }
  const outside = new Map<number, Use[]>();
  const working = new Set<number>();
  for (const u of g.uses) {
    const owner = g.thingOf[u.item] ?? null;
    if (owner === null || items[u.item]!.kind !== "field") continue;
    const tangle = g.tangleOf[owner] ?? null;
    const insider = u.user !== null && (u.user === owner || (tangle !== null && g.tangleOf[u.user] === tangle));
    if (!insider) {
      const list = outside.get(u.item) ?? [];
      list.push(u);
      outside.set(u.item, list);
    } else if (u.user === owner) {
      const h = model.references[u.reference]!.holder;
      if (h !== null && items[h]!.kind === "function" && items[h]!.takesSelf) working.add(owner);
    }
  }
  const bare = (f: number) => {
    const n = items[f]!.name;
    return n.slice(n.lastIndexOf("::") + 2);
  };
  const out: Finding[] = [];
  for (const [thing, fs] of [...fields].sort((a, b) => a[0] - b[0])) {
    if (!fs.some((f) => !outside.has(f)) || !working.has(thing)) continue;
    for (const field of fs) {
      const uses = (outside.get(field) ?? []).filter((u) => !u.copies);
      if (!uses.length) continue;
      const known: string[] = [];
      const keptNames: string[] = [];
      for (const o of fs) {
        if (o === field) continue;
        const us = outside.get(o);
        if (!us) keptNames.push(bare(o));
        else if (us.some((u) => !u.copies)) known.push(bare(o));
      }
      const others: string[] = [];
      if (known.length) others.push(`also known outside: ${listed(known)}`);
      if (keptNames.length) others.push(`kept: ${listed(keptNames)}`);
      const sites = new Map<string, [Location, string]>();
      const places = new Map<number, Set<string>>();
      for (const u of uses) {
        const r = model.references[u.reference]!;
        const user = r.holder !== null ? `${tree.display(items[r.holder]!.owner)}::${items[r.holder]!.name}` : tree.display(r.from);
        const through = u.through !== null ? `, through \`${items[u.through]!.name}\`` : "";
        const at: Location = { file: model.files[r.file]!.path, line: r.line };
        const k = `${at.file}\0${String(at.line).padStart(8, "0")}`;
        const ps = places.get(r.from) ?? new Set<string>();
        ps.add(k);
        places.set(r.from, ps);
        if (!sites.has(k)) sites.set(k, [at, `\`${user}\`${through}`]);
      }
      const sorted = [...sites.values()].sort((a, b) => compareStrings(a[0].file, b[0].file) || a[0].line - b[0].line);
      const notes = sorted.slice(0, HELD_IN_MIND).map(([at, u]) => `${clickable(at)}: ${u}`);
      if (sorted.length > HELD_IN_MIND) notes.push(`and ${counted(sorted.length - HELD_IN_MIND, "more place")}`);
      let modules: [number, string][] = [...places].map(([m, p]): [number, string] => [p.size, tree.display(m)]).sort((a, b) => b[0] - a[0] || compareStrings(a[1], b[1]));
      const moduleCount = modules.length;
      if (moduleCount > HELD_IN_MIND) {
        const more = modules.slice(HELD_IN_MIND);
        modules = [...modules.slice(0, HELD_IN_MIND), [more.reduce((s, m) => s + m[0], 0), `in ${counted(more.length, "more module")}`]];
      }
      const owner = g.things[thing]!;
      const typeName = items[owner.item]!.name;
      const fieldName = items[field]!.name;
      out.push({
        lint: "field-leak",
        key: `${tree.display(owner.home)}::${fieldName}`,
        message: `\`${fieldName}\` is known outside \`${typeName}\`: ${counted(sorted.length, "place")} in ${counted(moduleCount, "module")}`,
        location: sorted[0]?.[0] ?? null,
        notes,
        picture: { kind: "spread", owner: `${tree.display(owner.home)}::${typeName}`, field: bare(field), modules, others },
      });
    }
  }
  return out;
}

// shallow-module: a module with child modules that shows more than seven
// functions to outside modules while it hides no more than it shows.
export function shallowModules(model: Model, g: Graph): Finding[] {
  const { tree, items } = model;
  const parents = new Set<number>();
  for (const id of tree.ids()) {
    const p = tree.parent(id);
    if (p !== null && !tree.isTest(id)) parents.add(p);
  }
  const judged = new Set(tree.ids().filter((id) => !tree.isTest(id) && (tree.node(id).kind === "package" || (tree.node(id).kind === "module" && parents.has(id)))));
  const home = (item: number) => {
    const t = g.thingOf[item] ?? null;
    return t === null ? null : g.things[t]!.home;
  };
  const working = (item: number) => {
    const f = items[item]!;
    return f.kind === "function" && !f.traitImpl && !model.wrappers.has(item);
  };
  const modulesAround = (node: number) => {
    const pkg = tree.packageOf(node);
    const out: number[] = [];
    for (const a of tree.ancestors(node)) {
      if (tree.packageOf(a) !== pkg || tree.node(a).kind === "workspace") break;
      out.push(a);
    }
    return out;
  };
  const within = (node: number, module: number) => tree.isWithin(node, module) && tree.packageOf(node) === tree.packageOf(module);
  const total = new Map<number, number>();
  for (const [i] of items.entries()) {
    const h = home(i);
    if (h === null || !working(i)) continue;
    for (const m of modulesAround(h)) if (judged.has(m)) total.set(m, (total.get(m) ?? 0) + 1);
  }
  const shown = new Map<number, Set<number>>();
  for (const u of g.uses) {
    const at = home(u.item);
    if (at === null || !working(u.item)) continue;
    const r = model.references[u.reference]!;
    const user = u.user === null ? r.from : g.things[u.user]!.home;
    for (const m of modulesAround(at)) {
      if (within(user, m)) break;
      if (!judged.has(m)) continue;
      const s = shown.get(m) ?? new Set<number>();
      s.add(u.item);
      shown.set(m, s);
    }
  }
  // The types of its own module that each function knows, so a function
  // that works on a type is listed with it.
  const known = new Map<number, Set<number>>();
  const kind = (t: number) => items[g.things[t]!.item]!.kind;
  for (const u of g.uses) {
    const used = g.thingOf[u.item] ?? null;
    if (u.user === null || used === null || kind(u.user) !== "function" || kind(used) !== "type") continue;
    const s = known.get(u.user) ?? new Set<number>();
    s.add(used);
    known.set(u.user, s);
  }
  const out: Finding[] = [];
  for (const module of [...judged].sort((a, b) => a - b)) {
    const tot = total.get(module) ?? 0;
    const sh = shown.get(module);
    if (!sh) continue;
    const hidden = Math.max(0, tot - sh.size);
    const lists = new Map<number, string[]>();
    for (const fn of [...sh].sort((a, b) => a - b)) {
      const thing = g.thingOf[fn] ?? null;
      if (thing === null) continue;
      let on = [thing];
      if (g.things[thing]!.item === fn) {
        const types = [...(known.get(thing) ?? [])].filter((t) => within(g.things[t]!.home, module));
        if (types.length) on = types.sort((a, b) => a - b);
      }
      for (const l of on) {
        const list = lists.get(l) ?? [];
        list.push(items[fn]!.name);
        lists.set(l, list);
      }
    }
    const byName = [...lists]
      .sort((a, b) => a[0] - b[0])
      .map(([t, fns]): [string, string[]] => [items[g.things[t]!.item]!.name, fns.sort(compareStrings)])
      .sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1].join(","), b[1].join(",")));
    // Widest list first; the sort is stable, so ties keep name order.
    const ls = byName.toSorted((a, b) => b[1].length - a[1].length);
    const notes: string[] = [];
    const long: [string, number][] = [];
    if (ls.length > HELD_IN_MIND) {
      notes.push(`shows ${counted(ls.length, "thing")}: ${listed(ls.map((l) => l[0]))}`);
      long.push(["things", ls.length]);
    }
    for (const [thing, fns] of ls) {
      if (fns.length <= HELD_IN_MIND) continue;
      notes.push(`\`${thing}\` shows ${counted(fns.length, "function")}: ${listed(fns)}`);
      long.push([thing, fns.length]);
    }
    if (!(sh.size > HELD_IN_MIND && notes.length && hidden <= sh.size * BREAK_EVEN)) continue;
    const name = tree.display(module);
    out.push({
      lint: "shallow-module",
      key: name,
      message: `\`${name}\` is shallow: it shows ${sh.size} of its ${counted(tot, "function")}`,
      location: moduleLocation(model, module),
      notes,
      picture: { kind: "lists", shown: sh.size, hidden, lists: long },
    });
  }
  return out;
}

// The first line of the module's primary file: its index.ts, the file of the
// same name beside its directory, else its directory.
function moduleLocation(model: Model, module: number): Location | null {
  const own = model.files
    .filter((f) => !f.test && f.module === module)
    .sort((a, b) => Number(b.index) - Number(a.index) || compareStrings(a.path, b.path));
  if (own[0]) return { file: own[0].path, line: 1 };
  const dir = model.tree.node(module).dir;
  return dir !== null ? { file: `${dir}/`, line: 0 } : null;
}

// long-file and wide-directory, from the file paths alone.
export function layoutFindings(files: SourceFile[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (f.lines <= MOST_LINES) continue;
    out.push({
      lint: "long-file",
      key: f.path,
      message: `\`${f.path}\` is long: it has ${f.lines} lines, more than ${MOST_LINES}`,
      location: { file: f.path, line: 1 },
      notes: [],
      picture: { kind: "bar", label: "lines", length: f.lines, most: MOST_LINES },
    });
  }
  const dirs = new Map<string, Set<string>>();
  for (const f of files) {
    let start = 0;
    const p = f.path;
    const ends = [...p.matchAll(/\//g)].map((m) => m.index + 1).concat([p.length]);
    for (const end of ends) {
      const dir = p.slice(0, Math.max(0, start - 1));
      const s = dirs.get(dir) ?? new Set<string>();
      s.add(p.slice(start, end));
      dirs.set(dir, s);
      start = end;
    }
  }
  for (const [dir, members] of [...dirs].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (members.size <= MOST_MEMBERS) continue;
    const shownDir = dir ? `${dir}/` : "./";
    const ms = [...members].sort(compareStrings);
    const ds = ms.filter((m) => m.endsWith("/"));
    const fs = ms.filter((m) => !m.endsWith("/"));
    const notes: string[] = [];
    if (fs.length) notes.push(`${counted(fs.length, "file")}: ${listed(fs)}`);
    if (ds.length) notes.push(`${ds.length} ${ds.length === 1 ? "directory" : "directories"}: ${listed(ds)}`);
    const declaring = ["index.ts", "index.tsx"].find((n) => members.has(n));
    const beside = files.find((f) => f.path === `${dir}.ts` || f.path === `${dir}.tsx`);
    out.push({
      lint: "wide-directory",
      key: shownDir,
      message: `\`${shownDir}\` is wide: it holds ${members.size} files and directories, more than ${MOST_MEMBERS}`,
      location: declaring ? { file: `${dir}/${declaring}`, line: 1 } : beside ? { file: beside.path, line: 1 } : null,
      notes,
      picture: { kind: "bar", label: "holds", length: members.size, most: MOST_MEMBERS },
    });
  }
  return out;
}
