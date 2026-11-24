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
      "module-cycle fixture::cycle::one::a,fixture::cycle::one::b",
      "module-cycle fixture::cycle::three::bracket::s,fixture::cycle::three::bracket::t",
      "module-cycle fixture::cycle::three::dot::s,fixture::cycle::three::dot::t",
      "module-cycle fixture::cycle::two::a,fixture::cycle::two::b",
      "module-cycle fixture::tangle::one::alpha,fixture::tangle::one::beta",
      "tangle fixture::tangle::one::alpha::Alpha,fixture::tangle::one::beta::Beta",
      "field-leak fixture::field::counter::Counter::total",
      "field-leak fixture::field::gauge::Gauge::level",
    ]);
  });
});
