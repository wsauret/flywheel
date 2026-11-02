import { afterEach, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Schema } from "effect";
import { readMutationEvidenceFiles } from "../../../../../src/infra/mutation-evidence.js";
import { MutationEvidenceSchema } from "../../../../../src/infra/mutation-evidence-schema.js";
import { asRecord } from "../../../../../src/infra/record.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { privateCopyRemovals } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { bashMutationHarness, settled } from "./_bash-mutations-harness.js";
import { createRecordingFileMutationStore } from "./_fixtures.js";
import { makeMockOwnedProcess, type OwnedExit } from "./_bash-fixtures.js";
import { readSessionContentRange } from "../../../../../src/infra/session-content.js";

const createDirectory = temporaryDirectories();
const { project, runMutation, runManagedMutation, runHandedOverMutation } = bashMutationHarness(createDirectory);
beforeAll(loadBashParser);
afterEach(privateCopyRemovals);
const mutationOf = (details: unknown) => Schema.decodeUnknownSync(MutationEvidenceSchema)(asRecord(details)?.mutationEvidence);
const TERMINATED: OwnedExit = { code: 143, signal: null, statusOf: "payload", ownership: "surrendered" };

it("reports shared session-folder writes with project evidence and excludes runtime state", async () => {
  const prefix = ".flywheel/sessions/own/scratch";
  const root = project([
    [`${prefix}/notes/abc/checkpoint.md`, "before\n"],
    [`${prefix}/removed.txt`, "removed\n"],
    [`${prefix}/notes/flywheel-foreground-user.txt`, "user before\n"],
    [".flywheel/sessions/own/owner.pid", "1\n"],
  ]);
  const scratchDir = path.join(root, prefix);
  const mutate = (cwd: string) => {
    fs.appendFileSync(path.join(cwd, prefix, "notes/abc/checkpoint.md"), "after\n");
    fs.writeFileSync(path.join(scratchDir, "absolute.txt"), "absolute\n");
    fs.writeFileSync(path.join(cwd, prefix, "created.txt"), "created\n");
    fs.writeFileSync(path.join(scratchDir, "binary.bin"), Buffer.from([255, 0, 1]));
    fs.unlinkSync(path.join(scratchDir, "removed.txt"));
    for (const name of [`${prefix}/mutations/ignored.txt`, `${prefix}/flywheel-agent-bg-test.log`, ".flywheel/sessions/other/scratch/other.txt", ".flywheel/flywheel.sqlite"]) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), "ignored\n");
    }
    fs.writeFileSync(path.join(cwd, "project.txt"), "project\n");
    fs.appendFileSync(path.join(scratchDir, "notes/flywheel-foreground-user.txt"), "user after\n");
    fs.writeFileSync(path.join(path.dirname(scratchDir), "d1.txt"), "session file\n");
    fs.writeFileSync(path.join(path.dirname(scratchDir), "owner.pid"), "2\n");
  };
  const { result, store } = await runMutation(root, mutate, {}, { scratchDir });
  const evidence = mutationOf(result.details);
  expect(evidence.applied).toBe(8);
  const page = await readMutationEvidenceFiles(evidence, 0, 100, store.readContentNode);
  if (page.kind !== "available") throw new Error("missing session-folder evidence");
  const files = page.files.flatMap(entry => entry.kind === "applied" ? [entry.file] : []);
  expect(files.map(file => [file.displayPath.replaceAll(path.sep, "/"), file.change]).sort()).toEqual([
    [".flywheel/sessions/own/d1.txt", "added"],
    [`${prefix}/absolute.txt`, "added"],
    [`${prefix}/binary.bin`, "added"],
    [`${prefix}/created.txt`, "added"],
    [`${prefix}/notes/abc/checkpoint.md`, "modified"],
    [`${prefix}/notes/flywheel-foreground-user.txt`, "modified"],
    [`${prefix}/removed.txt`, "removed"],
    ["project.txt", "added"],
  ]);
  for (const [displayPath, before, after, changedLine] of [
    [path.join(prefix, "notes/abc/checkpoint.md"), "before\n", "before\nafter\n", "+after"],
    [path.join(prefix, "created.txt"), null, "created\n", "+created"],
    [path.join(prefix, "removed.txt"), "removed\n", null, "-removed"],
    [path.join(".flywheel", "sessions", "own", "d1.txt"), null, "session file\n", "+session file"],
  ] as const) {
    const file = files.find(candidate => candidate.displayPath === displayPath)!;
    expect(file.before?.bytes ?? null).toBe(before === null ? null : Buffer.byteLength(before));
    expect(file.after?.bytes ?? null).toBe(after === null ? null : Buffer.byteLength(after));
    if (file.patch.kind !== "retained") throw new Error("session-folder diff missing");
    const patch = await readSessionContentRange(file.patch.reference, 0, file.patch.reference.bytes, store.readContentNode);
    expect(patch.kind).toBe("available");
    if (patch.kind === "available") expect(Buffer.from(patch.base64, "base64").toString()).toContain(changedLine);
  }
  expect(files.find(file => file.displayPath.endsWith("binary.bin"))).toMatchObject({ before: null, after: { bytes: 3 }, patch: { kind: "unavailable" } });
  expect(result.content).toContain("Recorded in session folder:");
  expect(result.content).not.toContain("No project files changed.");
  expect(result.content).toContain("open this command's file-change evidence");
  expect(result.content).not.toContain("open Session Changes");
  expect(store.changes.map(change => change.displayPath)).toEqual(["project.txt"]);
});

it("records each topmost removed directory once before its files and removes the emptied project directory", async () => {
  const prefix = ".flywheel/sessions/session-1/scratch";
  const root = project([
    ["d/sub/a.txt", "aa\n"], ["d/b.txt", "b\n"], ["kept/gone.txt", "gone\n"], ["kept/stays.txt", "stays\n"],
    [`${prefix}/dl/x/one.txt`, "one\n"], [`${prefix}/dl/two.bin`, Buffer.from([255, 0])], [`${prefix}/note.md`, "note\n"],
  ]);
  const { result, store } = await runMutation(root, cwd => {
    fs.rmSync(path.join(cwd, "d"), { recursive: true });
    fs.rmSync(path.join(cwd, "kept/gone.txt"));
    fs.rmSync(path.join(cwd, prefix, "dl"), { recursive: true });
  });
  const evidence = mutationOf(result.details);
  expect(evidence).toMatchObject({ applied: 5, removed: 5, removedDirectories: 2, filesInRemovedDirectories: 4 });
  const page = await readMutationEvidenceFiles(evidence, 0, 100, store.readContentNode);
  if (page.kind !== "available") throw new Error("evidence unavailable");
  const directories = page.files.flatMap(entry => entry.kind === "removed_directory" ? [[entry.displayPath.replaceAll(path.sep, "/"), entry.files, entry.bytes]] : []);
  expect(directories).toEqual([["d", 2, 5], [`${prefix}/dl`, 2, 6]]);
  expect(page.files.slice(0, 2).every(entry => entry.kind === "removed_directory")).toBe(true);
  const files = page.files.flatMap(entry => entry.kind === "applied" ? [entry.file.displayPath.replaceAll(path.sep, "/")] : []);
  expect(files.sort()).toEqual([`${prefix}/dl/two.bin`, `${prefix}/dl/x/one.txt`, "d/b.txt", "d/sub/a.txt", "kept/gone.txt"].sort());
  expect(evidence.samples[0]).toMatchObject({ kind: "removed_directory", path: "d", files: 2, bytes: 5 });
  expect(fs.existsSync(path.join(root, "d"))).toBe(false);
  expect(fs.readdirSync(path.join(root, "kept"))).toEqual(["stays.txt"]);
});

it("keeps a removed project directory that still holds a file the command did not delete", async () => {
  const root = project([["d/sub/a.txt", "a\n"]]);
  const { result } = await runMutation(root, cwd => {
    fs.rmSync(path.join(cwd, "d"), { recursive: true });
    fs.writeFileSync(path.join(root, "d/sub/concurrent.txt"), "concurrent\n");
  });
  expect(mutationOf(result.details)).toMatchObject({ removedDirectories: 1 });
  expect(fs.readdirSync(path.join(root, "d/sub"))).toEqual(["concurrent.txt"]);
});

it("records and removes a project directory and a session-folder directory that held no file", async () => {
  const prefix = ".flywheel/sessions/session-1/scratch";
  const root = project([[`${prefix}/note.md`, "note\n"]]);
  for (const directory of ["e/f", `${prefix}/empty/inner`]) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const { result, store } = await runMutation(root, cwd => {
    fs.rmSync(path.join(cwd, "e"), { recursive: true });
    fs.rmSync(path.join(cwd, prefix, "empty"), { recursive: true });
  });
  const evidence = mutationOf(result.details);
  expect(evidence).toMatchObject({ applied: 0, removedDirectories: 2, filesInRemovedDirectories: 0 });
  const page = await readMutationEvidenceFiles(evidence, 0, 100, store.readContentNode);
  if (page.kind !== "available") throw new Error("evidence unavailable");
  expect(page.files.map(entry => entry.kind === "removed_directory" ? [entry.displayPath.replaceAll(path.sep, "/"), entry.files, entry.bytes] : entry.kind)).toEqual([["e", 0, 0], [`${prefix}/empty`, 0, 0]]);
  expect(fs.existsSync(path.join(root, "e"))).toBe(false);
});

it.each(["directory", "parent"] as const)("never removes a directory outside the project when the removed %s became a link", async replaced => {
  const root = project([["p/d/sub/a.txt", "a\n"]]);
  const outside = createDirectory("bash-mutation-outside-");
  fs.mkdirSync(path.join(outside, "d", "sub"), { recursive: true });
  fs.mkdirSync(path.join(outside, "sub"));
  const { result } = await runMutation(root, cwd => {
    fs.rmSync(path.join(cwd, "p/d"), { recursive: true });
    const link = path.join(root, replaced === "directory" ? "p/d" : "p");
    fs.renameSync(link, `${link}-moved`);
    fs.symlinkSync(outside, link, "junction");
  });
  expect(mutationOf(result.details)).toMatchObject({ removedDirectories: 1 });
  expect(fs.existsSync(path.join(outside, replaced === "directory" ? "sub" : "d/sub"))).toBe(true);
});

it("reports damaged session-folder evidence without hiding project changes", async () => {
  const root = project([[".flywheel/sessions/session-1/scratch/note.md", "before\n"]]);
  const { result, store } = await runMutation(root, cwd => {
    fs.writeFileSync(path.join(cwd, "project.txt"), "project\n");
    fs.writeFileSync(path.join(root, ".flywheel/sessions/session-1/scratch/note.md"), "after\n");
    const image = path.join(path.dirname(path.dirname(cwd)), "session-before", "scratch", "note.md");
    fs.unlinkSync(image);
    fs.symlinkSync(path.join(root, ".flywheel/sessions/session-1/scratch/note.md"), image);
  });
  expect(result.content).toContain("Session-folder changes could not be verified because the before image was damaged.");
  expect(result.content).toContain("Applied to the project:");
  expect(mutationOf(result.details)).toMatchObject({ applied: 1 });
  expect(store.changes.map(change => change.displayPath)).toEqual(["project.txt"]);
});

it("records shared session-folder evidence when a later build lands the command", async () => {
  const root = project([[".flywheel/sessions/session-1/scratch/notes/checkpoint.md", "before\n"]]);
  const run = await runHandedOverMutation(root, cwd => {
    fs.appendFileSync(path.join(cwd, ".flywheel/sessions/session-1/scratch/notes/checkpoint.md"), "after\n");
  });
  expect(run.recorded[0]!.mutation.mutationEvidence).toMatchObject({ applied: 1, notApplied: 0 });
  expect(run.notifications.join("\n")).toContain("Updated .flywheel/sessions/session-1/scratch/notes/checkpoint.md".replaceAll("/", path.sep));
  expect(run.fileChanges).toEqual([]);
  expect(fs.readFileSync(path.join(root, ".flywheel/sessions/session-1/scratch/notes/checkpoint.md"), "utf8")).toBe("before\nafter\n");
});

it("reports no changes when only excluded session runtime files change", async () => {
  const root = project([[".flywheel/sessions/own/scratch/notes/a.md", "unchanged\n"]]);
  const scratchDir = path.join(root, ".flywheel/sessions/own/scratch");
  const { result } = await runMutation(root, () => {
    fs.writeFileSync(path.join(scratchDir, "flywheel-agent-bg-test.log"), "runtime\n");
    fs.writeFileSync(path.join(path.dirname(scratchDir), "owner.pid"), "2\n");
  }, {}, { scratchDir });
  expect(result.content).toContain("No project files changed.");
});

it("discards an interrupted foreground command's project mutation and removes its copy while retaining session-folder evidence", async () => {
  const root = project([["a.txt", "a\n"], [".flywheel/sessions/session-1/scratch/note.md", "before\n"]]);
  const controller = new AbortController();
  const exit = Promise.withResolvers<OwnedExit>();
  const { result, store } = await runMutation(root, cwd => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
    fs.appendFileSync(path.join(cwd, ".flywheel/sessions/session-1/scratch/note.md"), "after\n");
    setTimeout(() => controller.abort(), 1);
  }, {}, { signal: controller.signal }, {
    make: () => makeMockOwnedProcess({ exited: exit.promise, terminate: async () => { exit.resolve(TERMINATED); return TERMINATED; } }),
  });
  expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
  expect(store.facts).toEqual([]);
  expect(result.content).toContain("The command was interrupted, so its changes to project files were discarded.");
  const evidence = mutationOf(result.details);
  expect(evidence).toMatchObject({ applied: 1, notApplied: 0 });
  const page = await readMutationEvidenceFiles(evidence, 0, 10, store.readContentNode);
  if (page.kind !== "available") throw new Error("session-folder evidence unavailable");
  expect(page.files).toMatchObject([{ kind: "applied", file: { displayPath: path.join(".flywheel", "sessions", "session-1", "scratch", "note.md"), change: "modified" } }]);
  expect(fs.readFileSync(path.join(root, ".flywheel/sessions/session-1/scratch/note.md"), "utf8")).toBe("before\nafter\n");
  await privateCopyRemovals();
  expect(fs.readdirSync(path.join(root, ".flywheel/sessions/session-1/scratch/mutations"))).toEqual([]);
});

it("discards a stopped background command's project mutation while retaining session-folder evidence", async () => {
  const root = project([["a.txt", "a\n"], [".flywheel/sessions/session-1/scratch/note.md", "before\n"]]);
  const exit = Promise.withResolvers<OwnedExit>();
  const run = await runManagedMutation(root, cwd => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
    fs.appendFileSync(path.join(cwd, ".flywheel/sessions/session-1/scratch/note.md"), "after\n");
  }, { background: true }, exit.promise);
  expect(run.registry.terminate("bash-1")).toBe(true);
  exit.resolve(TERMINATED);
  await settled(run.registry);
  expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
  expect(run.store.facts).toEqual([]);
  const report = "The command was interrupted, so its changes to project files were discarded.";
  expect(run.recorded.map(({ output }) => output)).toEqual([`${report}\nRecorded in session folder:\nUpdated ${path.join(".flywheel", "sessions", "session-1", "scratch", "note.md")}`]);
  expect(run.recorded[0]!.mutation.mutationEvidence).toMatchObject({ applied: 1, notApplied: 0 });
  expect(run.notifications[0]?.split(report)).toHaveLength(2);
});

it.each(["foreground", "managed"] as const)("keeps %s many-file reports bounded while paging every applied and refused file", async route => {
  const root = project([]);
  const mutate = (cwd: string) => {
    for (let index = 0; index < 40; index++) {
      const name = `file-${String(index).padStart(3, "0")}.txt`;
      fs.writeFileSync(path.join(cwd, name), "command\n");
      fs.writeFileSync(path.join(root, name), "project\n");
    }
    fs.writeFileSync(path.join(cwd, "applied.txt"), "new\n");
  };
  const run = route === "foreground" ? await runMutation(root, mutate, {}, {}, { mergeFile: () => 128 }) : await runManagedMutation(root, mutate, { background: true }, undefined, {}, () => 128);
  if ("registry" in run) await settled(run.registry);
  const evidence = "recorded" in run ? run.recorded[0]!.mutation.mutationEvidence! : mutationOf(run.result.details);
  expect(evidence).toMatchObject({ applied: 1, notApplied: 40 });
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(4096);
  const text = "notifications" in run ? run.notifications.join("\n") : run.result.content;
  expect(typeof text).toBe("string");
  expect(JSON.stringify(text).length).toBeLessThan(20 * 1024);
  expect(text).toContain("and 37 more not-applied files");
  let offset: number | null = 0;
  const entries = [];
  while (offset !== null) {
    const page = await readMutationEvidenceFiles(evidence, offset, 7, run.store.readContentNode);
    if (page.kind !== "available") throw new Error("missing manifest");
    entries.push(...page.files);
    offset = page.nextOffset;
  }
  expect(entries.filter(entry => entry.kind === "not_applied")).toHaveLength(40);
  expect(run.store.changes.map(change => change.displayPath)).toEqual(["applied.txt"]);
  expect(fs.readFileSync(path.join(root, "file-039.txt"), "utf8")).toBe("project\n");
});

it.each(["interrupted", "uncertain"] as const)("retains only the settled prefix when publication is %s", async state => {
  const root = project([["a.txt", "old a\n"], ["b.txt", "old b\n"], ["c.txt", "old c\n"]]);
  const store = createRecordingFileMutationStore();
  const controller = new AbortController();
  let settlements = 0;
  const writer = {
    ...store.writer,
    transaction: async (run: () => void) => {
      if (++settlements === 2 && state === "uncertain") throw new Error("settlement unavailable");
      await store.writer.transaction(run);
      if (settlements === 1 && state === "interrupted") controller.abort();
    },
  };
  const { result } = await runMutation(root, cwd => {
    for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(cwd, `${name}.txt`), `new ${name}\n`);
  }, {}, { sessionEventWriter: writer, signal: controller.signal });
  expect(mutationOf(result.details)).toMatchObject({ applied: 1, notApplied: state === "interrupted" ? 2 : 1 });
  const page = await readMutationEvidenceFiles(mutationOf(result.details), 0, 100, store.readContentNode);
  if (page.kind !== "available") throw new Error("evidence unavailable");
  expect(page.files.filter(entry => entry.kind === "applied").map(entry => entry.kind === "applied" && entry.file.displayPath)).toEqual(["a.txt"]);
  expect(store.changes.map(change => change.displayPath)).toEqual(["a.txt"]);
  expect(fs.readFileSync(path.join(root, "c.txt"), "utf8")).toBe("old c\n");
});
