import { describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildModel } from "../../../scripts/architecture/build-model.js";
import { layOut } from "../../../scripts/architecture/layout.js";
import { check } from "../../../scripts/architecture/rules.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

// Planted cases, each with the decision of ARCH-STRUCTURE-045 that it pins.
const FIXTURE = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, lib: ["ESNext"], types: [] },
    include: ["src/**/*.ts"],
  }),
  // A value cycle between sibling directories.
  "src/cycle/one/a/x.ts": 'import { gy } from "../b/y";\nexport function fx(): number { return gy() + 1; }\n',
  "src/cycle/one/a/z.ts": "export function kz(): number { return 2; }\n",
  "src/cycle/one/b/y.ts": 'import { kz } from "../a/z";\nexport function gy(): number { return 1; }\nexport function hy(): number { return kz(); }\n',
  // A cycle that only `export default <expression>` closes.
  "src/cycle/two/a.ts": 'import { gb } from "./b";\nexport function fa(): number { return 1; }\nexport default gb();\n',
  "src/cycle/two/b.ts": 'import { fa } from "./a";\nexport function gb(): number { return fa(); }\n',
  // Run-time reads of a field of a type-imported interface close a cycle, by
  // dot and by bracket alike.
  "src/cycle/three/dot/s.ts": 'import type { T } from "./t";\nexport function sizeOf(t: T): number { return t.size; }\n',
  "src/cycle/three/dot/t.ts": 'import { sizeOf } from "./s";\nexport interface T { size: number }\nexport function makeT(): number { return sizeOf({ size: 1 }); }\n',
  "src/cycle/three/bracket/s.ts": 'import type { T } from "./t";\nexport function sizeOf(t: T): number { return t["size"]; }\n',
  "src/cycle/three/bracket/t.ts": 'import { sizeOf } from "./s";\nexport interface T { size: number }\nexport function makeT(): number { return sizeOf({ size: 1 }); }\n',
  // Run-time reads of the fields of a union type alias close a cycle.
  "src/cycle/five/s.ts":
    'import type { Shape } from "./t";\nexport function areaOf(s: Shape): number { return s.kind === "square" ? s.side : s.radius; }\n',
  "src/cycle/five/t.ts":
    'import { areaOf } from "./s";\nexport type Shape = { kind: "square"; side: number } | { kind: "circle"; radius: number };\nexport function unit(): number { return areaOf({ kind: "square", side: 1 }); }\n',
  // Run-time reads and calls of the properties of a returned object literal
  // close a cycle, through a `return` statement and an arrow body alike, and
  // each kind of property on its own: a data read, a method call, a read
  // through a type assertion, and a read of what an anonymous default
  // function returns.
  "src/cycle/six/count/s.ts": 'import type { Bar } from "./t";\nexport function show(bar: Bar): number { return bar.count; }\n',
  "src/cycle/six/count/t.ts":
    'import { show } from "./s";\n' +
    "export function createBar() {\n  let count = 0;\n  return { count, open(): void { count++; } };\n}\nexport type Bar = ReturnType<typeof createBar>;\n" +
    "export function start(): number { return show(createBar()); }\n",
  "src/cycle/six/open/s.ts": 'import type { Bar } from "./t";\nexport function show(bar: Bar): void { bar.open(); }\n',
  "src/cycle/six/open/t.ts":
    'import { show } from "./s";\n' +
    "export function createBar() {\n  let count = 0;\n  return { count, open(): void { count++; } };\n}\nexport type Bar = ReturnType<typeof createBar>;\n" +
    "export function start(): void { show(createBar()); }\n",
  "src/cycle/six/asserted/s.ts": 'import type { Box } from "./t";\nexport function read(box: Box): number { return box.count; }\n',
  "src/cycle/six/asserted/t.ts":
    'import { read } from "./s";\nexport function createBox() { return { count: 1 } as { count: number }; }\nexport type Box = ReturnType<typeof createBox>;\n' +
    "export function start(): number { return read(createBox()); }\n",
  "src/cycle/six/default/s.ts": 'import type make from "./t";\nexport function read(box: ReturnType<typeof make>): number { return box.count; }\n',
  "src/cycle/six/default/t.ts":
    'import { read } from "./s";\nexport default function () { return { count: 1 }; }\nexport function start(): number { return read({ count: 2 }); }\n',
  "src/cycle/eight/s.ts": 'import type { Gate } from "./t";\nexport function pass(gate: Gate): boolean { return gate.isOpen(); }\n',
  "src/cycle/eight/t.ts":
    'import { pass } from "./s";\nexport const createGate = () => ({ isOpen: (): boolean => true });\nexport type Gate = ReturnType<typeof createGate>;\n' +
    "export function start(): boolean { return pass(createGate()); }\n",
  // Type-only imports of such types with no run-time read: no finding.
  "src/cycle/seven/s.ts":
    'import type { Bar, Shape } from "./t";\nexport interface Holder { shape: Shape | null; bar: Bar | null }\nexport function empty(): Holder { return { shape: null, bar: null }; }\n',
  "src/cycle/seven/t.ts":
    'import { empty } from "./s";\nexport type Shape = { kind: "a"; x: number } | { kind: "b"; y: number };\n' +
    "export const createBar = () => ({ size: 1, grow(): number { return 2; } });\nexport type Bar = ReturnType<typeof createBar>;\n" +
    "export function start(): boolean { return empty().shape === null; }\n",
  // Reads of the discriminant of a union of types from several modules
  // depend on the union, not on each member's module: no finding.
  "src/cycle/nine/all.ts": 'import type { XPayload } from "./x";\nimport type { YPayload } from "./y";\nexport type AllPayload = XPayload | YPayload;\n',
  "src/cycle/nine/x.ts":
    'import type { AllPayload } from "./all";\nexport type XPayload = { kind: "x"; size: number };\nexport function isX(p: AllPayload): p is XPayload { return p.kind === "x"; }\n',
  "src/cycle/nine/y.ts":
    'import type { AllPayload } from "./all";\nexport type YPayload = { kind: "y"; name: string };\nexport function isY(p: AllPayload): p is YPayload { return p.kind === "y"; }\n',
  // A read of a field that several types of one module share still links:
  // through an intersection, a union of named types, and a union of a named
  // type and a type literal.
  "src/cycle/ten/intersection/s.ts": 'import type { AB } from "./t";\nexport function sizeOf(v: AB): number { return v.size; }\n',
  "src/cycle/ten/intersection/t.ts":
    'import { sizeOf } from "./s";\nexport interface A { size: number }\nexport interface B { size: number }\nexport type AB = A & B;\n' +
    "export function start(): number { return sizeOf({ size: 1 }); }\n",
  "src/cycle/ten/union/s.ts": 'import type { XY } from "./t";\nexport function isX(v: XY): boolean { return v.kind === "x"; }\n',
  "src/cycle/ten/union/t.ts":
    'import { isX } from "./s";\nexport type X = { kind: "x"; n: number };\nexport type Y = { kind: "y"; m: number };\nexport type XY = X | Y;\n' +
    'export function start(): boolean { return isX({ kind: "x", n: 1 }); }\n',
  "src/cycle/ten/mixed/s.ts": 'import type { XZ } from "./t";\nexport function isX(v: XZ): boolean { return v.kind === "x"; }\n',
  "src/cycle/ten/mixed/t.ts":
    'import { isX } from "./s";\nexport type X = { kind: "x"; n: number };\nexport type XZ = X | { kind: "z"; m: number };\n' +
    'export function start(): boolean { return isX({ kind: "x", n: 1 }); }\n',
  // A cycle of type-only imports: no finding.
  "src/cycle/four/s.ts": 'import type { T } from "./t";\nexport interface S { t: T | null; name: string }\nexport function makeS(): S { return { t: null, name: "s" }; }\n',
  "src/cycle/four/t.ts": 'import type { S } from "./s";\nexport interface T { s: S | null; size: number }\nexport function makeT(): T { return { s: null, size: 1 }; }\n',
  // Classes that call each other through type-imported parameters: a tangle,
  // and a module cycle because the calls are value links.
  "src/tangle/one/alpha.ts": 'import type { Beta } from "./beta";\nexport class Alpha {\n  run(beta: Beta): number { return beta.step(this) * 2; }\n  ping(): number { return 1; }\n}\n',
  "src/tangle/one/beta.ts": 'import type { Alpha } from "./alpha";\nexport class Beta {\n  step(alpha: Alpha): number { return alpha.ping() + 1; }\n}\n',
  // Interfaces that name each other only in types: no finding.
  "src/tangle/four/doc.ts": 'import type { Reader } from "./reader";\nexport interface Doc { title: string; readers: Reader[] }\n',
  "src/tangle/four/reader.ts": 'import type { Doc } from "./doc";\nexport interface Reader { name: string; favourite: Doc | null }\n',
  // An outside write of a field leaks it, by dot and by bracket alike;
  // awaiting a promise field, or calling a read-only method on a field whose
  // read-only methods call each other, does not.
  "src/field/counter.ts": "export class Counter {\n  total = 0;\n  private step = 1;\n  bump(): void { this.total += this.step; }\n}\n",
  "src/field/job.ts": "export class Job {\n  done: Promise<void> = Promise.resolve();\n  private runs = 0;\n  run(): void { this.runs++; }\n}\n",
  "src/field/gauge.ts": "export class Gauge {\n  level = 0;\n  private step = 1;\n  raise(): void { this.level += this.step; }\n}\n",
  "src/field/shelf.ts":
    "export class Reader {\n  private count = 1;\n  size(): number { return this.total(); }\n  total(): number { return this.count; }\n}\nexport class Shelf {\n  reader = new Reader();\n  private books = 0;\n  add(): void { this.books++; }\n}\n",
  // The object that a factory returns is judged like a class: its method
  // works on it through `this`, so an outside write of its field leaks it,
  // while a shape that only its own method touches does not.
  "src/field/tally.ts":
    "export function createTally() {\n  return { total: 0, step: 1, bump(): void { this.total += this.step; } };\n}\nexport type Tally = ReturnType<typeof createTally>;\n" +
    "export function createMeter() {\n  return { level: 0, step: 1, raise(): void { this.level += this.step; } };\n}\nexport type Meter = ReturnType<typeof createMeter>;\n",
  "src/field/tally-users.ts":
    'import type { Meter, Tally } from "./tally";\nexport function zero(tally: Tally): void { tally.total = 0; }\nexport function lift(meter: Meter): void { meter.raise(); }\n',
  "src/field/users.ts":
    'import type { Counter } from "./counter";\nimport type { Gauge } from "./gauge";\nimport type { Job } from "./job";\nimport type { Shelf } from "./shelf";\n' +
    'export function reset(counter: Counter): void { counter.total = 0; }\nexport function drain(gauge: Gauge): void { gauge["level"] = 0; }\n' +
    'export async function wait(job: Job): Promise<void> { await job.done; }\nexport function count(shelf: Shelf): number { return shelf.reader.size(); }\n',
};

describe("check:architecture model", () => {
  it("finds the planted cases with the TypeScript 7 compiler", async () => {
    const root = realpathSync(temporaryDirectory("flywheel-architecture-model-"));
    for (const [file, text] of Object.entries(FIXTURE)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    const laid = layOut(root, [{ name: "fixture", dir: "src" }]);
    const findings = check(await buildModel(root, laid, join(root, "tsconfig.json")));
    expect(findings.map((f) => `${f.lint} ${f.key}`)).toEqual([
      "module-cycle fixture::cycle::eight::s,fixture::cycle::eight::t",
      "module-cycle fixture::cycle::five::s,fixture::cycle::five::t",
      "module-cycle fixture::cycle::one::a,fixture::cycle::one::b",
      "module-cycle fixture::cycle::six::asserted::s,fixture::cycle::six::asserted::t",
      "module-cycle fixture::cycle::six::count::s,fixture::cycle::six::count::t",
      "module-cycle fixture::cycle::six::default::s,fixture::cycle::six::default::t",
      "module-cycle fixture::cycle::six::open::s,fixture::cycle::six::open::t",
      "module-cycle fixture::cycle::ten::intersection::s,fixture::cycle::ten::intersection::t",
      "module-cycle fixture::cycle::ten::mixed::s,fixture::cycle::ten::mixed::t",
      "module-cycle fixture::cycle::ten::union::s,fixture::cycle::ten::union::t",
      "module-cycle fixture::cycle::three::bracket::s,fixture::cycle::three::bracket::t",
      "module-cycle fixture::cycle::three::dot::s,fixture::cycle::three::dot::t",
      "module-cycle fixture::cycle::two::a,fixture::cycle::two::b",
      "module-cycle fixture::tangle::one::alpha,fixture::tangle::one::beta",
      "tangle fixture::tangle::one::alpha::Alpha,fixture::tangle::one::beta::Beta",
      "field-leak fixture::field::counter::Counter::total",
      "field-leak fixture::field::gauge::Gauge::level",
      "field-leak fixture::field::tally::createTally::total",
    ]);
  });
});
