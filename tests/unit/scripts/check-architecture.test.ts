import { describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding } from "../../../scripts/architecture/graph.js";
import { reconcile, type KnownFinding } from "../../../scripts/architecture/known-findings.js";
import { layOut, markTestOnly } from "../../../scripts/architecture/layout.js";
import { Tree, type Item, type ItemKind, type Model, type Reference, type SourceFile } from "../../../scripts/architecture/model.js";
import { renderFinding } from "../../../scripts/architecture/render.js";
import { check, layoutFindings } from "../../../scripts/architecture/rules.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

// A hand-built model of package `p` at `src/`: what the TypeScript builder
// would record for the planted cases, without a compiler process.
class ModelBuilder {
  readonly tree = new Tree();
  readonly files: SourceFile[] = [];
  readonly items: Item[] = [];
  readonly references: Reference[] = [];
  private readonly pkg: number;
  private readonly fileOf = new Map<number, number>();

  constructor() {
    this.pkg = this.tree.child(this.tree.root(), "package", "p");
    this.tree.node(this.pkg).dir = "src";
  }

  // The module at `modulePath` (`a/b` is file `src/a/b.ts`), with its file.
  module(modulePath: string): number {
    let node = this.pkg;
    let dir = "src";
    for (const part of modulePath.split("/")) {
      node = this.tree.child(node, "module", part);
      this.tree.node(node).dir ??= `${dir}/${part}`;
      dir = `${dir}/${part}`;
    }
    if (!this.fileOf.has(node)) {
      this.fileOf.set(node, this.files.length);
      this.files.push({ path: `src/${modulePath}.ts`, module: node, test: false, lines: 1, index: false });
    }
    return node;
  }

  item(module: number, name: string, kind: ItemKind, parent: number | null = null, takesSelf = false): number {
    const file = this.fileOf.get(module) ?? null;
    this.items.push({ name, owner: module, file, kind, parent, traitImpl: false, takesSelf, holdsNothing: false, line: 1 });
    return this.items.length - 1;
  }

  // A use of `item` in `module`, inside the body of `holder`.
  use(module: number, holder: number | null, item: number, options: { typeOnly?: boolean; copies?: boolean } = {}): void {
    const file = this.fileOf.get(module) ?? 0;
    this.references.push({ file, line: this.references.length + 1, from: module, holder, item, copies: options.copies ?? false, test: false, typeOnly: options.typeOnly ?? false });
  }

  model(): Model {
    return { tree: this.tree, files: this.files, items: this.items, references: this.references, wrappers: new Map() };
  }
}

const keys = (model: Model, lint: Finding["lint"]) => check(model).filter((f) => f.lint === lint).map((f) => f.key);

// Two sibling modules whose functions call each other, through value or type
// references.
function twoModuleLoop(typeOnly: boolean): Model {
  const b = new ModelBuilder();
  const a = b.module("cycle/a");
  const z = b.module("cycle/b");
  const fa = b.item(a, "fa", "function");
  const fb = b.item(z, "fb", "function");
  b.use(a, fa, fb, { typeOnly });
  b.use(z, fb, fa, { typeOnly });
  return b.model();
}

describe("module-cycle", () => {
  it("names sibling modules that use each other through values", () => {
    expect(keys(twoModuleLoop(false), "module-cycle")).toEqual(["p::cycle::a,p::cycle::b"]);
  });

  it("ignores a circle that only type-only references close", () => {
    expect(keys(twoModuleLoop(true), "module-cycle")).toEqual([]);
  });

  it("counts a runtime read of a field of a type-imported interface", () => {
    const b = new ModelBuilder();
    const s = b.module("cycle/s");
    const t = b.module("cycle/t");
    const contract = b.item(t, "T", "type");
    const size = b.item(t, "T::size", "field", contract);
    const makeS = b.item(s, "makeS", "function");
    const makeT = b.item(t, "makeT", "function");
    // `import type { T }` in s: the annotation is type-only, the read of `t.size` is a value.
    b.use(s, makeS, contract, { typeOnly: true });
    b.use(s, makeS, size);
    b.use(t, makeT, makeS);
    expect(keys(b.model(), "module-cycle")).toEqual(["p::cycle::s,p::cycle::t"]);
  });

  it("does not tie a module to the module that holds it", () => {
    const b = new ModelBuilder();
    const outer = b.module("outer");
    const inner = b.module("outer/inner");
    const f = b.item(outer, "f", "function");
    const g = b.item(inner, "g", "function");
    b.use(outer, f, g);
    b.use(inner, g, f);
    expect(keys(b.model(), "module-cycle")).toEqual([]);
  });
});

// Two classes in two modules whose methods call each other.
function alphaBeta(typeOnly: boolean, sameModule = false): Model {
  const b = new ModelBuilder();
  const alphaHome = b.module("tangle/alpha");
  const betaHome = sameModule ? alphaHome : b.module("tangle/beta");
  const alpha = b.item(alphaHome, "Alpha", "type");
  const run = b.item(alphaHome, "Alpha::run", "function", alpha, true);
  const ping = b.item(alphaHome, "Alpha::ping", "function", alpha, true);
  const beta = b.item(betaHome, "Beta", "type");
  const step = b.item(betaHome, "Beta::step", "function", beta, true);
  b.use(alphaHome, run, step, { typeOnly });
  b.use(betaHome, step, ping, { typeOnly });
  return b.model();
}

describe("tangle", () => {
  it("names things in two modules that know each other through calls", () => {
    expect(keys(alphaBeta(false), "tangle")).toEqual(["p::tangle::alpha::Alpha,p::tangle::beta::Beta"]);
  });

  it("ignores a circle of types that only know each other through types", () => {
    expect(keys(alphaBeta(true), "tangle")).toEqual([]);
  });

  it("ignores a circle inside one module", () => {
    expect(keys(alphaBeta(false, true), "tangle")).toEqual([]);
  });
});

// A counter whose own method works on both fields, and an outside function
// that uses `total`.
function counter(copies: boolean): Model {
  const b = new ModelBuilder();
  const home = b.module("field/counter");
  const users = b.module("field/users");
  const owner = b.item(home, "Counter", "type");
  const total = b.item(home, "Counter::total", "field", owner);
  const stepField = b.item(home, "Counter::step", "field", owner);
  const bump = b.item(home, "Counter::bump", "function", owner, true);
  b.use(home, bump, total);
  b.use(home, bump, stepField);
  const reset = b.item(users, "reset", "function");
  b.use(users, reset, total, { copies });
  return b.model();
}

describe("field-leak", () => {
  it("names a field that outside code writes", () => {
    expect(keys(counter(false), "field-leak")).toEqual(["p::field::counter::Counter::total"]);
  });

  it("ignores a field that outside code only reads", () => {
    expect(keys(counter(true), "field-leak")).toEqual([]);
  });
});

// A module `util` (with child module `tools`) whose functions an outside
// module calls: `shown` called, `hidden` only used inside.
function library(shown: number, hidden: number): Model {
  const b = new ModelBuilder();
  const tools = b.module("util/tools");
  const app = b.module("app");
  const main = b.item(app, "main", "function");
  for (let i = 0; i < shown; i++) b.use(app, main, b.item(tools, `tool${i}`, "function"));
  for (let i = 0; i < hidden; i++) b.item(tools, `helper${i}`, "function");
  return b.model();
}

describe("shallow-module", () => {
  it("names a module that shows more than seven functions and hides fewer", () => {
    expect(keys(library(10, 1), "shallow-module")).toEqual(["p::util"]);
  });

  it("ignores a module that hides more than it shows", () => {
    expect(keys(library(10, 11), "shallow-module")).toEqual([]);
  });

  it("ignores a module that shows seven functions", () => {
    expect(keys(library(7, 0), "shallow-module")).toEqual([]);
  });
});

describe("wide-directory and long-file", () => {
  const files = (dir: string, count: number, lines = 1): SourceFile[] =>
    Array.from({ length: count }, (_, i) => ({ path: `${dir}/f${i}.ts`, module: 0, test: false, lines, index: false }));

  it("names a directory with more than fifteen entries", () => {
    const found = layoutFindings([...files("src/wide", 16), ...files("src/ok", 15)]);
    expect(found.filter((f) => f.lint === "wide-directory").map((f) => f.key)).toEqual(["src/wide/"]);
  });

  it("names a file with more than 2000 lines", () => {
    const found = layoutFindings([...files("src/long", 1, 2001), ...files("src/short", 1, 2000)]);
    expect(found.filter((f) => f.lint === "long-file").map((f) => f.key)).toEqual(["src/long/f0.ts"]);
  });
});

describe("renderFinding", () => {
  it("prints the message, the location, the notes, and the circle", () => {
    const [finding] = check(twoModuleLoop(false));
    expect(renderFinding(finding!).split("\n")).toEqual([
      "error[module-cycle]: 2 modules in `p::cycle` use each other in a circle",
      "  --> src/cycle/a.ts:1:1",
      "  = note: members: a, b",
      "  = note: src/cycle/a.ts:1:1: `a` uses `b` by 1 item: fb",
      "  = note: src/cycle/b.ts:2:1: `b` uses `a` by 1 item: fa",
      "    ┌─▶ a",
      "    │     ┃ a.ts:1  fa uses fb",
      "    │     ▼",
      "    │   b",
      "    │     │ b.ts:2  fb uses fa",
      "    └─────┘",
      "",
      "",
    ]);
  });
});

describe("reconcile", () => {
  const finding = (lint: Finding["lint"], key: string): Finding => ({ lint, key, message: "", location: null, notes: [], picture: { kind: "bar", label: "", length: 0, most: 0 } });
  const entry = (lint: Finding["lint"], key: string): KnownFinding => ({ lint, key, reason: "reviewed" });

  it("passes a finding that an entry names", () => {
    expect(reconcile([finding("field-leak", "p::A::x")], [entry("field-leak", "p::A::x")])).toEqual({ unknown: [], stale: [] });
  });

  it("reports a finding that no entry names", () => {
    const fresh = finding("module-cycle", "p::a,p::b");
    expect(reconcile([fresh], [entry("field-leak", "p::a")])).toEqual({ unknown: [fresh], stale: [entry("field-leak", "p::a")] });
  });

  it("reports an entry that no finding matches", () => {
    expect(reconcile([], [entry("shallow-module", "p::util")])).toEqual({ unknown: [], stale: [entry("shallow-module", "p::util")] });
  });

  it("reports a circle that grew, split, or replaced a listed one, and the listed one as stale", () => {
    const listed = entry("module-cycle", "p::a,p::b");
    for (const now of [["p::a,p::b,p::c"], ["p::b,p::c"], ["p::a,p::x", "p::b,p::y"]]) {
      const found = now.map((key) => finding("module-cycle", key));
      expect(reconcile(found, [listed])).toEqual({ unknown: found, stale: [listed] });
    }
  });

  it("matches other findings by the whole key", () => {
    const leak = finding("field-leak", "p::A::x");
    expect(reconcile([leak], [entry("field-leak", "p::A::x,p::A::y")]).unknown).toEqual([leak]);
  });
});

describe("markTestOnly", () => {
  it("marks files that only tests import, and keeps entry points and files that production imports, also only as types", () => {
    // Bun's resolver answers with real paths, and the temporary directory of macOS is behind a symlink.
    const root = realpathSync(temporaryDirectory("flywheel-architecture-layout-"));
    const write = (file: string, text: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    write("src/app.ts", 'import { shared } from "./shared";\nimport type { Contract } from "./contract";\nexport const app: Contract = { shared };\n');
    write("src/contract.ts", "export interface Contract { shared: number }\nexport const sample: Contract = { shared: 0 };\n");
    write("src/shared.ts", "export const shared = 1;\n");
    write("src/fixture.ts", 'import { helper } from "./fixture-helper";\nexport const fixture = helper;\n');
    write("src/fixture-helper.ts", "export const helper = 2;\n");
    write("src/cli.ts", "if (import.meta.main) console.log(1);\nexport const cli = 3;\n");
    write("tests/app.test.ts", 'import { fixture } from "../src/fixture";\nimport { shared } from "../src/shared";\nimport { cli } from "../src/cli";\nimport { sample } from "../src/contract";\nexport const all = [fixture, shared, cli, sample];\n');
    const laid = layOut(root, [{ name: "p", dir: "src" }]);
    expect(markTestOnly(root, laid)).toEqual(["src/fixture-helper.ts", "src/fixture.ts"]);
    expect(laid.files.filter((f) => f.test).map((f) => f.path)).toEqual(["src/fixture-helper.ts", "src/fixture.ts"]);
  });
});
