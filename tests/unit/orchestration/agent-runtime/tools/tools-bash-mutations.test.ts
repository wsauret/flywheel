/** Bash `mutates` commands over injected operations: the private copy, landing
 *  through the shared publisher, conflicts, managed landing, attribution, and
 *  copy removal. The integration tier runs the real shell and Git. */

import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { Schema } from "effect";
import { readMutationEvidenceFiles, type MutationEvidence } from "../../../../../src/infra/mutation-evidence.js";
import { MutationEvidenceSchema } from "../../../../../src/infra/mutation-evidence-schema.js";
import { readSessionContentRange, type ReadSessionContentNode } from "../../../../../src/infra/session-content.js";
import type { OwnedProcess } from "../../../../../src/infra/owned-subprocess.js";
import { asRecord } from "../../../../../src/infra/record.js";
import { parseBashResultDetails } from "../../../../../src/orchestration/agent-runtime/tools/bash.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { privateCopyRemovals } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js";
import type { ToolAttributionIdentity } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { GitAiAttributionService } from "../../../../../src/orchestration/agent-runtime/git-ai-attribution-service.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { makeMockOwnedProcess, type MergeFileFake, type OwnedExit } from "./_bash-fixtures.js";
import { bashMutationHarness, settled } from "./_bash-mutations-harness.js";
import { conflictMarkersNotice, notAppliedNotice } from "../../../../../src/protocol/client/file-change-body.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import { undoSessionChanges } from "../../../../../src/orchestration/file-edits/session-undo.js";
import { RetainedFileEditAuthority } from "../../../../../src/orchestration/file-edits/retained-file-edit-host.js";
import { getSessionChangeReview } from "../../../../../src/orchestration/session/session-change-review.js";
import { withStore } from "../../session/file-mutation-recovery-fixture.js";
import { Log } from "../../../../../src/infra/log.js";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { emitToolExecutionOutputRecorded } from "../../../../../src/orchestration/agent-runtime/emit.js";
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../../src/infra/runtime-fact-mapper.js";

// Registered at file scope, so it removes the projects only after each case's
// own hook below has waited for the copies inside them to be removed.
const createDirectory = temporaryDirectories();

beforeAll(async () => {
  await loadBashParser();
});

const TERMINATED: OwnedExit = { code: 143, signal: null, statusOf: "payload", ownership: "surrendered" };

describe("bash tool: mutation commands", () => {
  const { project, runMutation, runManagedMutation, runHandedOverMutation } = bashMutationHarness(createDirectory);
  afterEach(privateCopyRemovals);

  const mutationOf = (details: unknown): MutationEvidence => Schema.decodeUnknownSync(MutationEvidenceSchema)(asRecord(details)?.mutationEvidence);
  async function entriesOf(details: unknown, read: ReadSessionContentNode) {
    const page = await readMutationEvidenceFiles(mutationOf(details), 0, 100, read);
    if (page.kind !== "available") throw new Error("evidence unavailable");
    return page.files;
  }

  /** The copy homes still present once every started removal has finished. */
  async function remainingCopies(root: string): Promise<string[]> {
    await privateCopyRemovals();
    return fs.readdirSync(path.join(root, ".flywheel", "sessions", "session-1", "scratch", "mutations"));
  }

  /** A shell launch whose exit waits until the runner terminates it. */
  function heldUntilTerminated(): () => OwnedProcess {
    return () => {
      const exit = Promise.withResolvers<OwnedExit>();
      return makeMockOwnedProcess({ exited: exit.promise, terminate: async () => { exit.resolve(TERMINATED); return TERMINATED; } });
    };
  }

  it("publishes added, changed, deleted, binary, and untracked files exactly as this call's file mutations, then removes the copy", async () => {
    const root = project([["a.txt", "\uFEFFone\r\ntwo\r\n"], ["gone.txt", "bye\n"], ["img.bin", new Uint8Array([0x89, 0x50, 0x00, 0xff])]]);
    const { result, store, launches } = await runMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "\uFEFFone\r\nTWO\r\n");
      fs.rmSync(path.join(cwd, "gone.txt"));
      fs.writeFileSync(path.join(cwd, "img.bin"), new Uint8Array([0x00, 0xfe]));
      fs.mkdirSync(path.join(cwd, "new"));
      fs.writeFileSync(path.join(cwd, "new", "b.txt"), "made\n");
    });

    expect(launches[0]!.cwd).not.toBe(root);
    expect(fs.readFileSync(path.join(root, "a.txt"))).toEqual(Buffer.from("\uFEFFone\r\nTWO\r\n"));
    expect(fs.existsSync(path.join(root, "gone.txt"))).toBe(false);
    expect([...fs.readFileSync(path.join(root, "img.bin"))]).toEqual([0x00, 0xfe]);
    expect(fs.readFileSync(path.join(root, "new", "b.txt"), "utf8")).toBe("made\n");
    expect(result.content).toContain(["Applied to the project:", "Updated a.txt", "Deleted gone.txt", "Updated img.bin", `Created ${path.join("new", "b.txt")}`].join("\n"));
    expect(result.executionOutputTail).toBe("mock output\n");
    expect(parseBashResultDetails(result.details)).toMatchObject({ background: false, exitCode: 0 });
    expect(asRecord(result.details)?.mutationEvidence).toMatchObject({ version: 2, applied: 4 });
    expect(asRecord(result.details)?.mutation).toBeUndefined();
    expect((await entriesOf(result.details, store.readContentNode)).map(entry => entry.kind === "applied" ? [entry.file.displayPath, entry.file.change, entry.file.patch.kind] : entry.kind)).toEqual([["a.txt", "modified", "retained"], ["gone.txt", "removed", "retained"], ["img.bin", "modified", "unavailable"], [path.join("new", "b.txt"), "added", "retained"]]);
    expect(store.facts.filter((fact) => fact.type === "file.changed").map((fact) => fact.payload)).toEqual(["a.txt", "gone.txt", "img.bin", path.join("new", "b.txt")].map((displayPath) =>
      expect.objectContaining({ displayPath, origin: expect.objectContaining({ toolUseId: "bash-1" }) })));
    expect(await remainingCopies(root)).toEqual([]);
  });

  it("publishes files of any size and names the changes only regular file contents cannot carry", async () => {
    const large = 16 * 1024 * 1024 + 1;
    const root = project([["big.bin", Buffer.alloc(large, 1)], ["huge.log", Buffer.alloc(large, 2)]]);
    const { result } = await runMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "big.bin"), Buffer.alloc(large, 3));
      fs.rmSync(path.join(cwd, "huge.log"));
      fs.symlinkSync("big.bin", path.join(cwd, "link"));
    });

    expect(fs.readFileSync(path.join(root, "big.bin")).equals(Buffer.alloc(large, 3))).toBe(true);
    expect(fs.existsSync(path.join(root, "huge.log"))).toBe(false);
    expect(fs.existsSync(path.join(root, "link"))).toBe(false);
    expect(result.content).toContain("Applied to the project:\nUpdated big.bin\nDeleted huge.log");
    expect(result.content).toContain("Not applied, because only the contents of regular files land in the project: link (symbolic link created). Make these changes again without mutates.");
    expect(mutationOf(result.details)).toMatchObject({ applied: 2, retainedFiles: 2, notApplied: 1 });
    expect(result.executionOutputTail).toBe("mock output\n");
  });

  it("rebases files the project changed while the command ran onto the current files", async () => {
    const root = project([["a.txt", "a\n"], ["b.txt", "1\n2\n3\n"], ["c.txt", "x\n"]]);
    const answers = new Map<string, readonly [string, number]>([
      ["1\n2\nC\n", ["P\n2\nC\n", 0]],
      ["mine\n", ["<<<<<<< project\ntheirs\n=======\nmine\n>>>>>>> command\n", 1]],
      ["made\n", ["made\nalso\n", 0]],
    ]);
    const merges: Array<{ readonly labels: readonly string[]; readonly project: string; readonly base: string; readonly command: string }> = [];
    const mergeFile: MergeFileFake = ({ labels, current, base, other }) => {
      const command = fs.readFileSync(other, "utf8");
      merges.push({ labels, project: fs.readFileSync(current, "utf8"), base: fs.readFileSync(base, "utf8"), command });
      const [merged, code] = answers.get(command)!;
      fs.writeFileSync(current, merged);
      return code;
    };
    const { result, store } = await runMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "mine a\n");
      fs.writeFileSync(path.join(cwd, "b.txt"), "1\n2\nC\n");
      fs.writeFileSync(path.join(root, "b.txt"), "P\n2\n3\n");
      fs.writeFileSync(path.join(cwd, "c.txt"), "mine\n");
      fs.writeFileSync(path.join(root, "c.txt"), "theirs\n");
      fs.writeFileSync(path.join(cwd, "n.txt"), "made\n");
      fs.chmodSync(path.join(cwd, "n.txt"), 0o755);
      fs.writeFileSync(path.join(root, "n.txt"), "also\n");
      fs.chmodSync(path.join(root, "n.txt"), 0o640);
    }, {}, {}, { mergeFile });

    // Git receives the project's file, the file when the copy was taken (empty
    // for a file both sides created), and the command's result.
    const labels = ["-L", "project", "-L", "base", "-L", "command"];
    expect(merges.toSorted((one, two) => one.command.localeCompare(two.command))).toEqual([
      { labels, project: "P\n2\n3\n", base: "1\n2\n3\n", command: "1\n2\nC\n" },
      { labels, project: "also\n", base: "", command: "made\n" },
      { labels, project: "theirs\n", base: "x\n", command: "mine\n" },
    ]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine a\n");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("P\n2\nC\n");
    expect(fs.readFileSync(path.join(root, "c.txt"), "utf8")).toBe("<<<<<<< project\ntheirs\n=======\nmine\n>>>>>>> command\n");
    expect(fs.readFileSync(path.join(root, "n.txt"), "utf8")).toBe("made\nalso\n");
    // The merged file is the project's file, so it keeps the project's permissions, not the command's.
    if (process.platform !== "win32") expect(fs.statSync(path.join(root, "n.txt")).mode & 0o777).toBe(0o640);
    // The diff runs from the project's file to the merged one, so it holds only the command's hunk.
    const entries = await entriesOf(result.details, store.readContentNode);
    const rebased = entries.find(entry => entry.kind === "applied" && entry.file.displayPath === "b.txt");
    if (rebased?.kind !== "applied" || rebased.file.patch.kind !== "retained") throw new Error("missing retained patch");
    const window = await readSessionContentRange(rebased.file.patch.reference, 0, 64 * 1024, store.readContentNode);
    if (window.kind !== "available") throw new Error("missing patch bytes");
    const patch = Buffer.from(window.base64, "base64").toString("utf8");
    expect(patch).toContain("-3\n+C\n");
    expect(patch).not.toContain("+P");
    expect(entries.filter(entry => entry.kind === "applied" && entry.file.conflictMarkers).map(entry => entry.kind === "applied" && entry.file.displayPath)).toEqual(["c.txt"]);
    expect(mutationOf(result.details).notApplied).toBe(0);
    expect(store.facts.filter(fact => fact.type === "file.artifact.recorded").map(fact => fact.payload)).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ path: path.join(root, "c.txt"), conflictMarkers: true }) }));
    expect(result.content).toContain("These files also keep the changes the project made while the command ran: b.txt, n.txt");
    expect(result.content).toContain(`${conflictMarkersNotice(mutationOf(result.details))}. Edit each file to resolve the marked sections.`);
  });

  it("undoes a file landed with conflict markers to the project's file as it was just before publication", async () => {
    await withStore(async (fixture) => {
      const file = path.join(fixture.root, "c.txt");
      fs.writeFileSync(file, "x\n");
      const mergeFile: MergeFileFake = ({ current }) => {
        fs.writeFileSync(current, "<<<<<<< project\ntheirs\n=======\nmine\n>>>>>>> command\n");
        return 1;
      };
      const { result } = await runMutation(fixture.root, (cwd) => {
        fs.writeFileSync(path.join(cwd, "c.txt"), "mine\n");
        fs.writeFileSync(file, "theirs\n");
      }, {}, { sessionEventWriter: fixture.writer }, { mergeFile });
      await privateCopyRemovals();
      expect(mutationOf(result.details).conflictMarkers).toBe(1);
      // The per-file settlement owns Undo evidence even when no final tool result was saved.

      const review = await getSessionChangeReview(asAsyncEventReadSurface(fixture.store), fixture.sessionId);
      const changed = fixture.store.read({ sessionId: fixture.sessionId, types: ["file.changed"] }).find((fact) => fact.payload.path === file)!;
      const undo = { type: "session.changes.undo" as const, sessionId: fixture.sessionId, fileId: `file:${changed.id}`, revision: review.revision() };
      const undone = await undoSessionChanges({ reader: asAsyncEventReadSurface(fixture.store), projectionReader: asAsyncEventReadSurface(fixture.store), writer: asAsyncEventWriter(fixture.store), projectRoot: fixture.root, executionCwd: fixture.root, sessionId: fixture.sessionId }, undo, new AbortController().signal);

      expect(undone).toEqual({ status: "completed" });
      expect(fs.readFileSync(file, "utf8")).toBe("theirs\n");
    });
  });

  it("keeps the project's file and reports the command's change when it cannot merge the two", async () => {
    const root = project([["edited.txt", "old\n"], ["gone.txt", "bye\n"], ["img.bin", new Uint8Array([0x89, 0x00, 0x01])]]);
    const { result } = await runMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "edited.txt"), "new\n");
      fs.rmSync(path.join(root, "edited.txt"));
      fs.rmSync(path.join(cwd, "gone.txt"));
      fs.writeFileSync(path.join(root, "gone.txt"), "still here\n");
      fs.writeFileSync(path.join(cwd, "img.bin"), new Uint8Array([0x00, 0x02]));
      fs.writeFileSync(path.join(root, "img.bin"), new Uint8Array([0x00, 0x03, 0x04]));
    });

    const notApplied = [{ path: "edited.txt", reason: "the project deleted it" }, { path: "gone.txt", reason: "the command deleted it" }, { path: "img.bin", reason: "binary files are not merged" }];
    expect(fs.existsSync(path.join(root, "edited.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "gone.txt"), "utf8")).toBe("still here\n");
    expect([...fs.readFileSync(path.join(root, "img.bin"))]).toEqual([0x00, 0x03, 0x04]);
    expect(mutationOf(result.details)).toMatchObject({ applied: 0, notApplied: 3, samples: notApplied.map(file => ({ kind: "not_applied", ...file })) });
    expect(asRecord(result.details)?.mutation).toBeUndefined();
    expect(result.content).toContain(`${notAppliedNotice(mutationOf(result.details))}. Make these changes again against the current files if they are still necessary.`);
    expect(result.executionOutputTail).not.toContain(notAppliedNotice(mutationOf(result.details)));
    expect(result.executionOutputTail).toBe("mock output\n\nMake these changes again against the current files if they are still necessary.");
    const visibleOutput = `${result.executionOutputTail ?? ""}\n${notAppliedNotice(mutationOf(result.details))}`;
    expect(visibleOutput.split(notAppliedNotice(mutationOf(result.details)))).toHaveLength(2);
  });

  // Each admitted file retains a directory descriptor until its round settles. Darwin's posix_spawn refuses every
  // launch of a process that holds a descriptor numbered at or above 10240, so a package install that lands tens of
  // thousands of files once stopped every launch of the executor until its landing ended.
  it("lands a command's files in bounded rounds, so the retained directories do not grow with the files it wrote", async () => {
    const root = project([["kept.txt", "kept\n"]]);
    const original = RetainedFileEditAuthority.admitWritable.bind(RetainedFileEditAuthority);
    const held = { open: 0, peak: 0 };
    const admit = spyOn(RetainedFileEditAuthority, "admitWritable").mockImplementation((...args) => {
      const authority = original(...args);
      const close = authority.close.bind(authority);
      held.peak = Math.max(held.peak, ++held.open);
      authority.close = () => { held.open -= 1; close(); };
      return authority;
    });
    const files = Array.from({ length: 300 }, (_, index) => `file${index}.js`);
    const { result } = await runMutation(root, (cwd) => { for (const file of files) fs.writeFileSync(path.join(cwd, file), file); }).finally(() => admit.mockRestore());
    expect(mutationOf(result.details)).toMatchObject({ applied: files.length });
    expect(files.every(file => fs.readFileSync(path.join(root, file), "utf8") === file)).toBe(true);
    expect(held).toEqual({ open: 0, peak: 256 });
  });

  it("merges again when the project changes a file during publication, and reports a file that keeps changing", async () => {
    const root = project([["e.txt", "e\n"], ["f.txt", "f\n"]]);
    const merges = { e: 0, f: 0 };
    // Each merge appends the command's line; the project writes a file again
    // after Flywheel read it for the merge and before the merge could land.
    const mergeFile: MergeFileFake = ({ current, other }) => {
      const command = fs.readFileSync(other, "utf8");
      fs.writeFileSync(current, fs.readFileSync(current, "utf8") + command);
      if (command === "mine e\n" && ++merges.e === 1) fs.writeFileSync(path.join(root, "e.txt"), "theirs e, again\n");
      if (command === "mine f\n") fs.writeFileSync(path.join(root, "f.txt"), `theirs f ${++merges.f}\n`);
      return 0;
    };
    const { result } = await runMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "e.txt"), "mine e\n");
      fs.writeFileSync(path.join(root, "e.txt"), "theirs e\n");
      fs.writeFileSync(path.join(cwd, "f.txt"), "mine f\n");
      fs.writeFileSync(path.join(root, "f.txt"), "theirs f\n");
    }, {}, {}, { mergeFile });

    expect(merges).toEqual({ e: 2, f: 3 });
    expect(fs.readFileSync(path.join(root, "e.txt"), "utf8")).toBe("theirs e, again\nmine e\n");
    expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("theirs f 3\n");
    expect(mutationOf(result.details).samples).toContainEqual({ kind: "not_applied", path: "f.txt", reason: "it changed again after each merge" });
    expect(result.content).toContain("These files also keep the changes the project made while the command ran: e.txt");
  });

  it("merges the other files when the project deletes a file during its merge, and keeps that file deleted", async () => {
    const root = project([["a.txt", "a\n"], ["b.txt", "b\n"]]);
    const mergeFile: MergeFileFake = ({ current, other }) => {
      const command = fs.readFileSync(other, "utf8");
      fs.writeFileSync(current, fs.readFileSync(current, "utf8") + command);
      if (command === "mine a\n") fs.rmSync(path.join(root, "a.txt"));
      return 0;
    };
    const { result } = await runMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "mine a\n");
      fs.writeFileSync(path.join(root, "a.txt"), "theirs a\n");
      fs.writeFileSync(path.join(cwd, "b.txt"), "mine b\n");
      fs.writeFileSync(path.join(root, "b.txt"), "theirs b\n");
    }, {}, {}, { mergeFile });

    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("theirs b\nmine b\n");
    expect(mutationOf(result.details).samples).toContainEqual({ kind: "not_applied", path: "a.txt", reason: "the project deleted it" });
    expect(result.content).toContain("These files also keep the changes the project made while the command ran: b.txt");
  });

  it.skipIf(process.platform === "win32")("never merges a file from outside the project when the project puts a link in the file's path after the scan", async () => {
    const root = project([["a.txt", "a\n"], [path.join("sub", "b.txt"), "b\n"]]);
    const outside = fs.realpathSync(createDirectory("agent-bash-mutations-outside-"));
    fs.writeFileSync(path.join(outside, "b.txt"), "outside\n");
    const merged: string[] = [];
    // The merge of a.txt runs before the one of sub/b.txt; while it runs, the project replaces sub with a link.
    const mergeFile: MergeFileFake = ({ current, other }) => {
      merged.push(fs.readFileSync(current, "utf8"));
      fs.writeFileSync(current, fs.readFileSync(current, "utf8") + fs.readFileSync(other, "utf8"));
      fs.renameSync(path.join(root, "sub"), path.join(root, "moved"));
      fs.symlinkSync(outside, path.join(root, "sub"));
      return 0;
    };
    const { result } = await runMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "mine a\n");
      fs.writeFileSync(path.join(root, "a.txt"), "theirs a\n");
      fs.writeFileSync(path.join(cwd, "sub", "b.txt"), "mine b\n");
      fs.writeFileSync(path.join(root, "sub", "b.txt"), "theirs b\n");
    }, {}, {}, { mergeFile });

    expect(merged).toEqual(["theirs a\n"]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("theirs a\nmine a\n");
    expect(fs.readFileSync(path.join(outside, "b.txt"), "utf8")).toBe("outside\n");
    expect(mutationOf(result.details).samples).toContainEqual({ kind: "not_applied", path: path.join("sub", "b.txt"), reason: "it is no longer a regular file" });
  });

  it.each(["direct", "held", "background"] as const)("reports no change once in settled %s output and adds no mutation when the command changes nothing", async (route) => {
    const root = project([["a.txt", "a\n"]]);
    const streamed: string[] = [];
    const run = route === "direct"
      ? await runMutation(root, () => {}, {}, { onExecutionOutput: (text) => streamed.push(text) })
      : await runManagedMutation(root, () => {}, { background: route === "background" });
    if ("registry" in run) await settled(run.registry);
    const { result, store } = run;
    const report = "No project files changed.";

    if (route === "background" && "recorded" in run) {
      expect(run.recorded.map(({ output }) => output)).toEqual([report]);
      expect(result.content).not.toContain(report);
      expect(run.notifications[0]?.split(report)).toHaveLength(2);
    } else {
      if (typeof result.content !== "string") throw new Error("Bash returned non-text content");
      expect(result.content.split(report)).toHaveLength(2);
      expect(result.executionOutputTail).toBe(route === "direct" ? `mock output\n\n${report}` : report);
      expect(result.details).toEqual({ background: false, exitCode: 0, durationMs: expect.any(Number) });
    }
    if (route === "direct") expect(streamed.at(-1)).toBe(`mock output\n\n${report}`);
    expect(store.facts).toEqual([]);
  });

  it.each([
    { route: "live", name: ".git" }, { route: "adopted", name: ".git" },
    { route: "live", name: ".GIT" }, { route: "adopted", name: ".GIT" },
  ] as const)("rejects a new nested $name repository before file publication in a $route copy and retains its record", async ({ route, name }) => {
    const root = project([["a.txt", "a\n"], [".flywheel/sessions/session-1/scratch/note.md", "before\n"]]);
    fs.mkdirSync(path.join(root, "case-probe"));
    const caseInsensitive = fs.existsSync(path.join(root, "CASE-PROBE"));
    fs.rmdirSync(path.join(root, "case-probe"));
    if (name !== ".git" && !caseInsensitive) return;
    let copyRoot = "";
    const mutate = (cwd: string) => {
      copyRoot = cwd;
      fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
      fs.appendFileSync(path.join(cwd, ".flywheel/sessions/session-1/scratch/note.md"), "after\n");
      fs.mkdirSync(path.join(cwd, "nested", name), { recursive: true });
      fs.writeFileSync(path.join(cwd, "nested", name, "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(cwd, "nested", "adjacent.txt"), "nested edit\n");
    };
    const record = spyOn(DebugLog, "record");
    let reportOf: string;
    try {
      if (route === "live") {
        const { result } = await runMutation(root, mutate);
        if (typeof result.content !== "string") throw new Error("Bash returned non-text content");
        expect(mutationOf(result.details)).toMatchObject({ applied: 1, notApplied: 0 });
        reportOf = result.content;
      } else {
        const run = await runHandedOverMutation(root, mutate);
        expect(run.recorded[0]!.mutation.mutationEvidence).toMatchObject({ applied: 1, notApplied: 0 });
        expect(run.fileChanges).toEqual([]);
        reportOf = run.recorded[0]!.output;
      }
      expect(record.mock.calls.map(([event]) => event).filter(event => event.type === "agent.bash.mutation.applied").map(event => event.payload)).toEqual([{
        toolUseId: "bash-1", files: 0, rebased: 0, conflictMarkers: 0, notApplied: 0, unsupported: 0,
        status: "repository_changed", guard: expect.any(String), durationMs: expect.any(Number),
        ...(route === "live" ? { copy: "taken" } : {}), fate: "retained",
      }]);
    } finally {
      record.mockRestore();
    }
    const home = path.dirname(path.dirname(copyRoot));
    const report = `A Git command changed the repository inside this mutating command. None of the command's changes were applied to the project. The changed files remain in the copy at ${home}. Run Git commands as separate calls without mutates. Inspect the copy and apply the file changes you need.`;
    expect(reportOf).toContain(report);
    expect(reportOf).toContain(`Updated ${path.join(".flywheel", "sessions", "session-1", "scratch", "note.md")}`);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(fs.readFileSync(path.join(copyRoot, "a.txt"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(root, "nested"))).toBe(false);
    expect(fs.readFileSync(path.join(copyRoot, "nested", name, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(fs.readFileSync(path.join(copyRoot, "nested", "adjacent.txt"), "utf8")).toBe("nested edit\n");
    expect(fs.existsSync(path.join(home, "copy.json"))).toBe(true);
  });

  it("retains a copy with unavailable topology inspection without asserting a Git write", async () => {
    const root = project([["a.txt", "a\n"]]);
    let copyRoot = "";
    const { result, store } = await runMutation(root, cwd => {
      copyRoot = cwd;
      fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
      fs.renameSync(cwd, `${cwd}.saved`);
      fs.writeFileSync(cwd, "not a directory");
    });
    const home = path.dirname(path.dirname(copyRoot));
    expect(result.content).toContain(`Flywheel could not verify the private copy's repository state. None of the command's changes were applied to the project. The changed files remain in the copy at ${home}. Run Git commands as separate calls without mutates. Inspect the copy and apply the file changes you need.`);
    expect(result.content).not.toContain("A Git command changed");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(store.facts).toEqual([]);
    expect(fs.existsSync(path.join(home, "copy.json"))).toBe(true);
  });

  it("lands a foreground command's mutation when its timeout stops it", async () => {
    const root = project([["a.txt", "a\n"]]);
    const { result } = await runMutation(root, (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"), { timeout: 0.01 }, {}, { make: heldUntilTerminated() });

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
    expect(result.content).toContain("Updated a.txt");
  });

  it("removes the copy when the command cannot launch", async () => {
    const root = project([["a.txt", "a\n"]]);
    await runMutation(root, () => { throw new Error("launch refused"); }).catch(() => undefined);

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(await remainingCopies(root)).toEqual([]);
  });

  it("runs in the copy: the working directory maps into it, the literal project root is rewritten at path boundaries, and a written copy root lands as the real root", async () => {
    const root = project([[path.join("sub", "a.txt"), "a\n"]]);
    // As the shell would: the rewritten literal root and `$(pwd)` both name the copy.
    const { scripts, launches } = await runMutation(root, (cwd) => fs.writeFileSync(path.join(cwd, "out.txt"), `${path.dirname(cwd)}/sub/a.txt ${root}x/b\n${cwd}\n`), { command: `echo "${root}/sub/a.txt ${root}x/b" > out.txt && pwd >> out.txt` }, { executionCwd: path.join(root, "sub") });
    // The mutation guard's probe launches first, with no working directory.
    const copyRoot = path.dirname(launches.at(-1)!.cwd!);

    expect(path.basename(launches.at(-1)!.cwd!)).toBe("sub");
    expect(copyRoot.startsWith(path.join(root, ".flywheel", "sessions", "session-1", "scratch", "mutations"))).toBe(true);
    expect(scripts.join("\n")).toContain(`echo "${copyRoot}/sub/a.txt ${root}x/b" > out.txt`);
    expect(fs.readFileSync(path.join(root, "sub", "out.txt"), "utf8")).toBe(`${root}/sub/a.txt ${root}x/b\n${path.join(root, "sub")}\n`);
  });

  it("lands a command a planned replacement handed over on the build that adopted it, once, with the edit result the launching build lands", async () => {
    const files = [["a.txt", "a\n"], ["gone.txt", "bye\n"]] as const;
    const mutate = (cwd: string): void => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
      fs.rmSync(path.join(cwd, "gone.txt"));
      fs.writeFileSync(path.join(cwd, "new.txt"), "made\n");
    };
    const unhanded = await runManagedMutation(project(files), mutate, { background: true });
    await settled(unhanded.registry);
    const root = project(files);

    const run = await runHandedOverMutation(root, mutate);

    expect(run.beforeAdoption).toEqual({ files: [".flywheel", "a.txt", "gone.txt"], facts: 0, copy: true });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(root, "gone.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("made\n");
    expect(run.recorded).toEqual(unhanded.recorded.map(record => ({ ...record, mutation: { mutationEvidence: { ...record.mutation.mutationEvidence!, manifest: expect.objectContaining({ entries: record.mutation.mutationEvidence!.manifest.entries, root: expect.any(String) }) } } })));
    expect(run.order).toEqual(["recorded", "notified"]);
    const report = "Applied to the project:\nUpdated a.txt\nDeleted gone.txt\nCreated new.txt";
    expect(unhanded.notifications[0]).toContain(report);
    expect(run.notifications).toEqual([expect.stringContaining(report)]);
    expect(run.fileChanges).toEqual(["a.txt", "gone.txt", "new.txt"].map((displayPath) => expect.objectContaining({ displayPath, origin: expect.objectContaining({ toolUseId: "bash-1" }) })));
    expect(await remainingCopies(root)).toEqual([]);
  });

  it("lands the copy of a handed-over command that ended while no build held it, from its supervisor's record, and records its mutation once", async () => {
    const root = project([["a.txt", "a\n"]]);

    const endedAtMs = Date.now();
    const run = await runHandedOverMutation(root, (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"), {
      endedBetween: { kind: "record", record: { version: 1, handedOverAtMs: endedAtMs, outcome: { code: 0, signal: null, deadlineExpired: false, endedAtMs } } },
    });

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
    expect(run.order).toEqual(["recorded", "delivered"]);
    expect(run.recorded.map(({ toolUseId, mutation }) => [toolUseId, mutation.mutationEvidence?.samples.map(file => file.path)])).toEqual([["bash-1", ["a.txt"]]]);
    expect(run.notifications).toEqual([expect.stringContaining("Applied to the project:\nUpdated a.txt")]);
    expect(run.fileChanges).toEqual([expect.objectContaining({ displayPath: "a.txt", origin: expect.objectContaining({ toolUseId: "bash-1" }) })]);
    expect(await remainingCopies(root)).toEqual([]);
  });

  it("discards the copy of a handed-over command that a dying runtime ended before any build held it, as an interrupt's", async () => {
    const root = project([["a.txt", "a\n"]]);

    const run = await runHandedOverMutation(root, (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"), { endedBetween: { kind: "absent" } });

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(run.fileChanges).toEqual([]);
    expect(run.notifications).toEqual([expect.stringContaining("Background command ended with the previous runtime")]);
    expect(run.notifications[0]).toContain("The command was interrupted, so its changes to project files were discarded.");
    expect(await remainingCopies(root)).toEqual([]);
  });

  it("rebases a handed-over command's changes onto files the project changed while it crossed the replacement, as the launching build does", async () => {
    const files = [["b.txt", "1\n2\n3\n"], ["c.txt", "x\n"], ["gone.txt", "bye\n"]] as const;
    const answers = new Map<string, readonly [string, number]>([
      ["1\n2\nC\n", ["P\n2\nC\n", 0]],
      ["mine\n", ["<<<<<<< project\ntheirs\n=======\nmine\n>>>>>>> command\n", 1]],
    ]);
    const mergeFile: MergeFileFake = ({ current, other }) => {
      const [merged, code] = answers.get(fs.readFileSync(other, "utf8"))!;
      fs.writeFileSync(current, merged);
      return code;
    };
    const inCopy = (cwd: string): void => {
      fs.writeFileSync(path.join(cwd, "b.txt"), "1\n2\nC\n");
      fs.writeFileSync(path.join(cwd, "c.txt"), "mine\n");
      fs.rmSync(path.join(cwd, "gone.txt"));
    };
    const inProject = (root: string): void => {
      fs.writeFileSync(path.join(root, "b.txt"), "P\n2\n3\n");
      fs.writeFileSync(path.join(root, "c.txt"), "theirs\n");
      fs.writeFileSync(path.join(root, "gone.txt"), "still here\n");
    };
    const root = project(files);
    const run = await runHandedOverMutation(root, inCopy, { mergeFile, crossing: () => inProject(root) });
    const unhandedRoot = project(files);
    const exit = Promise.withResolvers<OwnedExit>();
    const unhanded = await runManagedMutation(unhandedRoot, inCopy, { background: true }, exit.promise, {}, mergeFile);
    inProject(unhandedRoot);
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
    await settled(unhanded.registry);

    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("P\n2\nC\n");
    expect(fs.readFileSync(path.join(root, "c.txt"), "utf8")).toBe("<<<<<<< project\ntheirs\n=======\nmine\n>>>>>>> command\n");
    expect(fs.readFileSync(path.join(root, "gone.txt"), "utf8")).toBe("still here\n");
    const notApplied = [{ path: "gone.txt", reason: "the command deleted it" }];
    expect(run.recorded.map(({ mutation }) => mutation.mutationEvidence)).toEqual([expect.objectContaining({ applied: 2, conflictMarkers: 1, notApplied: 1, samples: [{ kind: "applied", path: "b.txt" }, { kind: "applied", path: "c.txt", conflictMarkers: true }, { kind: "not_applied", ...notApplied[0] }] })]);
    expect(run.recorded).toEqual(unhanded.recorded.map(record => ({ ...record, mutation: { mutationEvidence: { ...record.mutation.mutationEvidence!, manifest: expect.objectContaining({ entries: record.mutation.mutationEvidence!.manifest.entries, root: expect.any(String) }) } } })));
    for (const notification of [...run.notifications, unhanded.notifications[0]]) {
      expect(notification).toContain("These files also keep the changes the project made while the command ran: b.txt");
      expect(notification).toContain(`${conflictMarkersNotice(run.recorded[0]!.mutation.mutationEvidence!)}. Edit each file to resolve the marked sections.`);
      expect(notification).toContain(`${notAppliedNotice(run.recorded[0]!.mutation.mutationEvidence!)}. Make these changes again against the current files if they are still necessary.`);
    }
    expect(run.notifications).toHaveLength(1);
  });

  it.each([
    ["missing", (home: string) => { fs.rmSync(path.join(home, "copy.json")); }, "is missing"],
    ["of a version this build cannot read", (home: string) => {
      const record = path.join(home, "copy.json");
      fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, "utf8")), version: 999 }));
    }, "has version 999, which this build cannot read"],
  ] as const)("lands nothing from a handed-over copy whose record is %s: its completion names the copy, which stays, and the reason is recorded once", async (state, spoil, reason) => {
    const root = project([["a.txt", "a\n"]]);
    const warnings: string[] = [];
    let home = "";
    await Log.init({ forward: (record) => { if (record.type === "log.warn") warnings.push(JSON.stringify(record.payload)); } });
    let run: Awaited<ReturnType<typeof runHandedOverMutation>>;
    try {
      run = await runHandedOverMutation(root, (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"), {
        crossing: (copyHome) => {
          home = copyHome;
          spoil(copyHome);
        },
      });
    } finally {
      await Log.closeGlobal();
    }

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(run.fileChanges).toEqual([]);
    const report = `The runtime moved to a newer build while this command ran in a private copy of the project, and the newer build cannot land that copy, because the copy's record ${reason}. None of the command's changes were applied to the project. The changed files remain in the copy at ${home}.`;
    expect(run.recorded.map(({ output }) => output)).toEqual([report]);
    expect(run.notifications[0]?.split(report)).toHaveLength(2);
    expect(run.notifications).toEqual([expect.stringContaining(`because the copy's record ${reason}. None of the command's changes were applied to the project. The changed files remain in the copy at ${home}.`)]);
    expect(fs.readFileSync(path.join(home, "tree", path.basename(root), "a.txt"), "utf8")).toBe("mine\n");
    expect(warnings.filter((warning) => warning.includes("private copy cannot be landed"))).toEqual([expect.stringContaining(`"reason":"${state === "missing" ? "missing" : "unreadable"}"`)]);
  });

  it.each([1, 2, 3] as const)("retains a literal V%s Git-backed copy and its original record even when interrupted", async version => {
    const root = project([["a.txt", "a\n"]]);
    let home = "";
    let originalRecord = "";
    const run = await runHandedOverMutation(root, (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"), {
      crossing: copyHome => {
        home = copyHome;
        const { execution: _execution, ...record } = JSON.parse(fs.readFileSync(path.join(home, "copy.json"), "utf8"));
        originalRecord = JSON.stringify({
          ...record, version,
          ...(version === 1 ? { gitDir: undefined, privateGitDir: undefined, commonDir: undefined, workTrees: undefined }
            : version === 2 ? { gitDir: path.join(root, ".git"), privateGitDir: undefined, commonDir: undefined, workTrees: undefined }
              : { gitDir: path.join(root, ".git"), privateGitDir: path.join(home, "git"), commonDir: path.join(root, ".git"), workTrees: [root] }),
        });
        fs.writeFileSync(path.join(home, "copy.json"), originalRecord);
      },
      endedBetween: { kind: "record", record: { version: 1, handedOverAtMs: Date.now(), outcome: { code: 143, signal: "SIGTERM", deadlineExpired: false, endedAtMs: Date.now() } } },
    });
    const report = `The runtime moved to a newer build while this command ran in a private copy of the project, and the newer build cannot land that copy, because a build that still landed Git changes took it and its changes cannot be proven to be only the command's own file edits. None of the command's changes were applied to the project. The changed files and the copy's record remain at ${home}. Inspect that copy and apply the changes you need. Run Git commands as separate calls without mutates.`;
    expect(run.recorded.map(({ output }) => output)).toEqual([report]);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(run.fileChanges).toEqual([]);
    expect(fs.readFileSync(path.join(home, "copy.json"), "utf8")).toBe(originalRecord);
    expect(fs.readFileSync(path.join(home, "tree", path.basename(root), "a.txt"), "utf8")).toBe("mine\n");
  });

  it.each([2, 3] as const)("lands file changes from a literal V%s record explicitly outside Git", async version => {
    const root = project([["a.txt", "a\n"]]);
    const run = await runHandedOverMutation(root, cwd => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"), {
      crossing: home => {
        const { execution: _execution, ...record } = JSON.parse(fs.readFileSync(path.join(home, "copy.json"), "utf8"));
        fs.writeFileSync(path.join(home, "copy.json"), JSON.stringify({ ...record, version, ...(version === 2 ? { privateGitDir: undefined, commonDir: undefined, workTrees: undefined } : {}) }));
      },
    });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
    expect(run.fileChanges).toHaveLength(1);
  });

  it("lands a background command's mutation at exit, records them against the original call, notifies, then removes the copy", async () => {
    const root = project([["a.txt", "a\n"]]);
    const run = await runManagedMutation(root, (cwd) => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"), { background: true });
    await settled(run.registry);

    expect(parseBashResultDetails(run.result.details)).toMatchObject({ background: true });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
    expect(run.order).toEqual(["recorded", "notified"]);
    expect(run.recorded.map(({ toolUseId, mutation }) => [toolUseId, mutation.mutationEvidence?.samples.map(file => file.path), mutation.mutationEvidence?.conflictMarkers])).toEqual([["bash-1", ["a.txt"], 0]]);
    const recorded = run.recorded[0]!;
    const facts: ReturnType<typeof mapRuntimeEventToSessionRuntimeFacts> = [];
    emitToolExecutionOutputRecorded(event => facts.push(...mapRuntimeEventToSessionRuntimeFacts(event)), recorded.toolUseId, recorded.output, {}, recorded.mutation);
    expect(facts).toEqual([{ type: "tool.execution_output.recorded", version: 3, actor: "flywheel", payload: { toolUseId: "bash-1", output: recorded.output, mutationEvidence: recorded.mutation.mutationEvidence } }]);
    expect(run.notifications[0]).toContain("Applied to the project:\nUpdated a.txt");
    expect(run.store.facts.filter((fact) => fact.type === "file.changed").map((fact) => fact.payload)).toEqual([
      expect.objectContaining({ displayPath: "a.txt", origin: expect.objectContaining({ toolUseId: "bash-1" }) }),
    ]);
    expect(await remainingCopies(root)).toEqual([]);
  });

  it("lands an auto-yielded command's mutation when it exits and records a change it could not merge", async () => {
    const root = project([["a.txt", "a\n"], ["b.txt", "b\n"]]);
    const exit = Promise.withResolvers<OwnedExit>();
    const run = await runManagedMutation(root, (cwd) => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "mine a\n");
      fs.rmSync(path.join(cwd, "b.txt"));
    }, {}, exit.promise);

    expect(run.result.details).toMatchObject({ background: true, releaseReason: "runtime_cap" });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    fs.writeFileSync(path.join(root, "b.txt"), "theirs\n");
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
    await settled(run.registry);

    const notApplied = [{ path: "b.txt", reason: "the command deleted it" }];
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine a\n");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("theirs\n");
    expect(run.recorded.map(({ mutation }) => mutation.mutationEvidence)).toEqual([expect.objectContaining({ applied: 1, notApplied: 1, samples: [{ kind: "applied", path: "a.txt" }, { kind: "not_applied", ...notApplied[0] }] })]);
    expect(run.notifications[0]).toContain("Updated a.txt");
    expect(run.notifications[0]).toContain(notAppliedNotice(run.recorded[0]!.mutation.mutationEvidence!));
  });

  it.each(["foreground", "background"] as const)("offers a %s command's landed files to Git AI attribution once, through direct attribution", async (mode) => {
    const root = project([["a.txt", "a\n"], ["gone.txt", "bye\n"]]);
    const offered: Array<Parameters<GitAiAttributionService["direct"]>[0]> = [];
    const service: GitAiAttributionService = {
      canonicalRepositoryRoot: root,
      status: () => ({ kind: "available" }),
      subscribe: () => () => {},
      checkAvailability: async () => ({ kind: "available" }),
      registerRequest: (registration) => registration,
      direct: (operation) => { offered.push(operation); },
      dispose: async () => {},
    };
    const identity: ToolAttributionIdentity = { service, repositoryRoot: root, requestId: "request-1", profileId: "work", enabled: true, conversationId: "conversation-1", model: "model-1", transcriptBytes: 0, transcript: () => ({ messages: [] }) };
    const attribution = { gitAiAttribution: service, attributionIdentity: identity };
    const mutate = (cwd: string): void => {
      fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
      fs.rmSync(path.join(cwd, "gone.txt"));
    };

    if (mode === "foreground") await runMutation(root, mutate, {}, attribution);
    else await settled((await runManagedMutation(root, mutate, { background: true }, undefined, attribution)).registry);

    expect(offered.map((operation) => [operation.identity, operation.files.map((file) => [path.relative(root, file.path), file.afterContent])])).toEqual([
      [identity, [["a.txt", "mine\n"], ["gone.txt", ""]]],
    ]);
  });

  it("refuses mutation combined with persist_after_exit before launching anything", async () => {
    const root = project([]);
    const { result, launches } = await runMutation(root, () => {}, { background: true, persist_after_exit: true });

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("'mutates=true' cannot be combined with 'persist_after_exit=true'");
    expect(launches).toEqual([]);
  });
});
