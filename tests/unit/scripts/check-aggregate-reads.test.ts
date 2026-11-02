import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkAggregateReads, findAggregateReads } from "../../../scripts/aggregate-reads.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

function repoWith(files: { [relPath: string]: string }): string {
  const root = temporaryDirectory("flywheel-aggregate-reads-");
  for (const [relPath, content] of Object.entries(files)) {
    const file = join(root, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

async function found(root: string): Promise<string[]> {
  return (await findAggregateReads(root)).map((finding) => `${finding.line} ${finding.scope} ${finding.rule}`);
}

describe("check-aggregate-reads", () => {
  it("names each read from an aggregate's first fact and passes each bounded one", async () => {
    const root = repoWith({ "src/reads.ts": [
      "export async function full(reader: Reader, id: string) {",
      "  await reader.readSlice({ aggregateId: id, types: [\"a\"] }, true)",
      "  await readCapturedFacts(reader, { aggregateId: id })",
      "  const query = { aggregatePrefix: 'workflow:', beforePosition: 9 }",
      "  return reader.read(query)",
      "}",
      "export function alternatives(reader: Reader, c: boolean, after: number) {",
      "  reader.readSlice({ aggregateId: id, afterPosition: undefined })",
      "  reader.readSlice({ aggregateId: id, afterPosition: c ? after : undefined })",
      "  reader.readSlice(c ? { aggregateId: id, afterPosition: after } : { aggregateId: id })",
      "  reader.readSlice({ aggregateId: id, ...(c ? { afterPosition: after } : { fromSeq: 1 }) })",
      "  reader.readSlice({ aggregateId: id, ...(c ? { afterPosition: after } : {}), afterPosition: undefined })",
      "  const afterPosition = undefined",
      "  reader.readSlice({ aggregateId: id, afterPosition })",
      "  reader.readSlice({ aggregateId: id, afterPosition: void 0 })",
      "}",
      "export async function bounded(reader: Reader, id: string, after: number, fold: boolean) {",
      "  await reader.readSlice({ aggregateId: id, afterPosition: after })",
      "  await reader.readSlice({ aggregateId: id, order: \"desc\", limit: 1 })",
      "  await readCapturedFacts(reader, { aggregateId: id }, { afterPosition: after })",
      "  await reader.readSlice({ aggregateId: id, ...(fold ? { afterPosition: after } : {}) })",
      "  await assets.read({ root: \"core\", path: id })",
      "  return heldProjection(reader, id, () => createEventProjection(reader, { seed: () => reader.readSlice({ aggregateId: id }) }))",
      "}",
    ].join("\n") });

    expect(await found(root)).toEqual([
      "2 full full-aggregate-read",
      "3 full full-aggregate-read",
      "5 full full-aggregate-read",
      "8 alternatives full-aggregate-read",
      "9 alternatives full-aggregate-read",
      "10 alternatives full-aggregate-read",
      "12 alternatives full-aggregate-read",
      "14 alternatives full-aggregate-read",
      "15 alternatives full-aggregate-read",
      "21 bounded full-aggregate-read",
    ]);
  });

  it("names a durable read repeated per item, but not a retry loop or a loop's iterable", async () => {
    const root = repoWith({ "src/loops.ts": [
      "export async function perMember(reader: Reader, ids: string[]) {",
      "  for (const id of ids) await reader.readInFlight(id, \"kind\")",
      "  await Promise.all(ids.map((id) => reader.aggregateSeq(id)))",
      "  for await (const fact of capturedFacts(reader, { types: [\"a\"] }, { afterPosition: 0 })) use(fact)",
      "  while (true) { if (await reader.aggregateSeq(\"a\") > 0) break }",
      "}",
      "export function pages(reader: Reader, ids: string[]) {",
      "  for (const id of ids) reader.readPage({ aggregateId: id }, undefined, 0)",
      "  ids.map(() => reader.capturePosition())",
      "}",
    ].join("\n") });

    expect(await found(root)).toEqual([
      "2 perMember durable-read-in-loop",
      "3 perMember durable-read-in-loop",
      "8 pages durable-read-in-loop",
      "9 pages durable-read-in-loop",
    ]);
  });

  it("resolves const queries in their lexical scope without crossing shadowed bindings", async () => {
    const root = repoWith({ "src/scopes.ts": [
      "const query = { aggregateId: 'outer' }",
      "function full(reader: Reader) { const query = { aggregateId: 'a' }; return reader.readSlice(query) }",
      "function bounded(reader: Reader) { const query = { aggregateId: 'b', limit: 1 }; return reader.readSlice(query) }",
      "function nested(reader: Reader) {",
      "  { const query = { aggregateId: 'inner', limit: 1 }; reader.readSlice(query) }",
      "  reader.readSlice(query)",
      "}",
      "function parameter(reader: Reader, query: Query) { return reader.readSlice(query) }",
      "function local(reader: Reader) { let query = supplied; return reader.readSlice(query) }",
    ].join("\n") });
    expect(await found(root)).toEqual([
      "2 full full-aggregate-read",
      "6 nested full-aggregate-read",
    ]);
  });

  it("excuses a finding only by a reviewed allowance, and refuses an allowance nothing needs", async () => {
    const root = repoWith({ "src/once.ts": [
      "export function recover(reader: Reader) { return reader.readSlice({ aggregateId: \"workspace\" }) }",
      "export function list(reader: Reader) { return reader.readSlice({ aggregateId: \"catalog\" }) }",
    ].join("\n") });

    const report = await checkAggregateReads(root, [
      { file: "src/once.ts", scope: "recover", rule: "full-aggregate-read", reason: "startup recovery, once" },
      { file: "src/once.ts", scope: "gone", rule: "full-aggregate-read", reason: "a scope that no longer reads" },
    ]);

    expect(report.violations.map((finding) => finding.scope)).toEqual(["list"]);
    expect(report.staleAllowances.map((entry) => entry.scope)).toEqual(["gone"]);
  });
});
