/** The session tree is Flywheel-owned state inside a project directory the user
 *  and every tool can write. A component of it that another writer replaced must
 *  never carry an owner-lock write, a lock read, or a recursive deletion out of
 *  the project, and a session id that is not one path component must not name a
 *  directory at all. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CONTAINMENT_REFUSAL } from "../../../helpers/containment-refusal.js";
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureSessionDir, resolveOwnerPidPath, resolveSessionDir, resolveSessionsDir } from "../../../../src/infra/paths";
import {
  createBreadcrumbMaintenance,
  deleteSessionArtifacts,
  sessionArtifactInventory,
  sweepBreadcrumbs,
  writeArtifactBreadcrumb,
} from "../../../../src/orchestration/session/session-artifacts";
import { isSessionOwnerGone, removeOwnerPid, writeOwnerPid } from "../../../../src/orchestration/session/pid-lock";

const sessionId = "session-tree-safety";
let baseDir: string;
let outside: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-session-tree-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-session-outside-"));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("a session id is one path component", () => {
  it.each([["empty", ""], ["dot", "."], ["parent", ".."], ["separator", "a/b"], ["backslash", "..\\b"], ["nul", "with\0nul"]])(
    "refuses a %s session id everywhere a session names a directory",
    (_label, rejected) => {
      expect(() => resolveSessionDir(rejected, baseDir)).toThrow("one path component");
      expect(() => resolveOwnerPidPath(rejected, baseDir)).toThrow("one path component");
      expect(() => ensureSessionDir(rejected, baseDir)).toThrow("one path component");
      expect(() => writeOwnerPid(rejected, baseDir)).toThrow("one path component");
      expect(() => deleteSessionArtifacts(rejected, baseDir)).toThrow("one path component");
    },
  );
});

describe("the owner lock refuses a replaced session component", () => {
  it("refuses a session directory that is a symlink and writes no lock inside it", () => {
    fs.mkdirSync(resolveSessionsDir(baseDir), { recursive: true });
    fs.symlinkSync(outside, resolveSessionDir(sessionId, baseDir));

    expect(() => writeOwnerPid(sessionId, baseDir)).toThrow(CONTAINMENT_REFUSAL);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a sessions directory that is a symlink", () => {
    fs.mkdirSync(path.join(baseDir, ".flywheel"), { recursive: true });
    fs.symlinkSync(outside, resolveSessionsDir(baseDir));

    expect(() => writeOwnerPid(sessionId, baseDir)).toThrow(CONTAINMENT_REFUSAL);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("reads no owner through a lock that is a symlink, and removing it unlinks the link only", () => {
    ensureSessionDir(sessionId, baseDir);
    const target = path.join(outside, "owner.pid");
    // A pid no process holds: read through the link, it would prove the owner gone.
    fs.writeFileSync(target, String(2 ** 30));
    fs.symlinkSync(target, resolveOwnerPidPath(sessionId, baseDir));

    // The link is not a record, so the owner stays a question left open.
    expect(isSessionOwnerGone(sessionId, baseDir)).toBe(false);
    removeOwnerPid(sessionId, baseDir);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readdirSync(resolveSessionDir(sessionId, baseDir))).toEqual([]);
  });
});

describe("deleting one session's artifacts", () => {
  it("removes the tree and reports an absent one as done", () => {
    ensureSessionDir(sessionId, baseDir);
    fs.mkdirSync(path.join(resolveSessionDir(sessionId, baseDir), "scratch"), { recursive: true });
    fs.writeFileSync(path.join(resolveSessionDir(sessionId, baseDir), "scratch", "run.sh"), "#!/bin/sh\n");

    deleteSessionArtifacts(sessionId, baseDir);
    deleteSessionArtifacts(sessionId, baseDir);

    expect(fs.existsSync(resolveSessionDir(sessionId, baseDir))).toBe(false);
  });

  it("unlinks a symlink inside the session instead of deleting what it points at", () => {
    ensureSessionDir(sessionId, baseDir);
    fs.writeFileSync(path.join(outside, "evidence.txt"), "not ours");
    fs.symlinkSync(outside, path.join(resolveSessionDir(sessionId, baseDir), "scratch"));

    deleteSessionArtifacts(sessionId, baseDir);

    expect(fs.existsSync(resolveSessionDir(sessionId, baseDir))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "evidence.txt"), "utf8")).toBe("not ours");
  });

  it("deletes nothing outside the project when the session directory is a symlink", () => {
    fs.mkdirSync(resolveSessionsDir(baseDir), { recursive: true });
    fs.writeFileSync(path.join(outside, "evidence.txt"), "not ours");
    fs.symlinkSync(outside, resolveSessionDir(sessionId, baseDir));

    deleteSessionArtifacts(sessionId, baseDir);

    expect(fs.existsSync(resolveSessionDir(sessionId, baseDir))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "evidence.txt"), "utf8")).toBe("not ours");
  });
});

describe("a project root another writer replaced", () => {
  /** The project root is the base every session artifact operation walks from,
   *  and Flywheel owns that component: a link at it would carry a breadcrumb
   *  write, an inventory, a sweep, or a deletion into a tree the project does not
   *  own. */
  function linkedRoot(): string {
    const link = path.join(baseDir, "linked-root");
    fs.symlinkSync(outside, link);
    return link;
  }

  it("refuses every session artifact operation, and writes nothing through the link", () => {
    fs.mkdirSync(path.join(outside, ".flywheel", "sessions", sessionId), { recursive: true });
    fs.writeFileSync(path.join(outside, ".flywheel", "sessions", sessionId, "evidence.txt"), "not ours");
    const root = linkedRoot();

    expect(() => writeArtifactBreadcrumb({ projectRoot: root, artifactScopeId: sessionId, toolName: "bash", content: "payload" })).toThrow();
    expect(() => sessionArtifactInventory(root)).toThrow(CONTAINMENT_REFUSAL);
    expect(() => sweepBreadcrumbs(root, Date.now())).toThrow(CONTAINMENT_REFUSAL);
    expect(() => deleteSessionArtifacts(sessionId, root)).toThrow(CONTAINMENT_REFUSAL);

    expect(fs.readFileSync(path.join(outside, ".flywheel", "sessions", sessionId, "evidence.txt"), "utf8")).toBe("not ours");
    expect(fs.readdirSync(path.join(outside, ".flywheel"))).toEqual(["sessions"]);
  });
});

describe("one session's breadcrumb tree", () => {
  const breadcrumbDir = (id: string): string => path.join(baseDir, ".flywheel", "agent-outputs", id);

  /** A breadcrumb carries its write time in its name, so a test states the age
   *  it wants instead of touching the clock or the inode. */
  function plantBreadcrumb(id: string, writtenAt: number, tool = "search"): string {
    fs.mkdirSync(breadcrumbDir(id), { recursive: true });
    const name = `${tool}_${new Date(writtenAt).toISOString().replace(/[:.]/g, "-")}_abc123.txt`;
    const filePath = path.join(breadcrumbDir(id), name);
    fs.writeFileSync(filePath, "full output");
    return filePath;
  }

  it("writes one owner-only file per breadcrumb and refuses an id that is not one path component", () => {
    const written = writeArtifactBreadcrumb({ projectRoot: baseDir, artifactScopeId: sessionId, toolName: "bash", content: "payload" });

    expect(fs.readFileSync(written, "utf8")).toBe("payload");
    if (POSIX_FILE_MODES) expect(fs.statSync(written).mode & 0o777).toBe(0o600);
    expect(path.dirname(written)).toBe(breadcrumbDir(sessionId));
    expect(() => writeArtifactBreadcrumb({ projectRoot: baseDir, artifactScopeId: "a/b", toolName: "bash", content: "x" }))
      .toThrow("one path component");
  });

  it("deletes the breadcrumb tree with the session tree, and follows no link out of it", () => {
    ensureSessionDir(sessionId, baseDir);
    const breadcrumb = plantBreadcrumb(sessionId, Date.now());
    fs.writeFileSync(path.join(outside, "evidence.txt"), "not ours");
    fs.symlinkSync(outside, path.join(breadcrumbDir(sessionId), "linked"));

    deleteSessionArtifacts(sessionId, baseDir);

    expect(fs.existsSync(breadcrumb)).toBe(false);
    expect(fs.existsSync(breadcrumbDir(sessionId))).toBe(false);
    expect(fs.existsSync(resolveSessionDir(sessionId, baseDir))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "evidence.txt"), "utf8")).toBe("not ours");
  });
});

describe("the project-wide breadcrumb sweep", () => {
  const NOW = Date.parse("2026-08-06T12:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;

  function plant(id: string, modifiedAt: number, namedAt = modifiedAt): string {
    const dir = path.join(baseDir, ".flywheel", "agent-outputs", id);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `search_${new Date(namedAt).toISOString().replace(/[:.]/g, "-")}_abc123.txt`);
    fs.writeFileSync(filePath, "full output");
    fs.utimesSync(filePath, modifiedAt / 1_000, modifiedAt / 1_000);
    return filePath;
  }

  it("applies one cutoff to every session, and reports the trees it found", () => {
    const fresh = plant("session-fresh", NOW - 6 * DAY_MS);
    const aged = plant("session-aged", NOW - 8 * DAY_MS);
    ensureSessionDir("session-fresh", baseDir);

    expect(sessionArtifactInventory(baseDir)).toEqual([
      { sessionId: "session-aged", hasSessionDir: false, hasBreadcrumbDir: true },
      { sessionId: "session-fresh", hasSessionDir: true, hasBreadcrumbDir: true },
    ]);

    sweepBreadcrumbs(baseDir, NOW);

    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(aged)).toBe(false);
    // The emptied tree goes with its last breadcrumb; the session tree stays,
    // because only session deletion owns that.
    expect(fs.existsSync(path.dirname(aged))).toBe(false);
    expect(fs.existsSync(resolveSessionDir("session-fresh", baseDir))).toBe(true);
  });

  it("keeps a breadcrumb exactly at the retention boundary", () => {
    const boundary = plant("session-boundary", NOW - 7 * DAY_MS);

    sweepBreadcrumbs(baseDir, NOW);

    expect(fs.existsSync(boundary)).toBe(true);
  });

  it("uses file modification time rather than the timestamp in its name", () => {
    const expired = plant("session-expired-mtime", NOW - 8 * DAY_MS, NOW);
    const fresh = plant("session-fresh-mtime", NOW - 6 * DAY_MS, NOW - 30 * DAY_MS);

    sweepBreadcrumbs(baseDir, NOW);

    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("leaves a name it did not mint where it stands", () => {
    const dir = path.join(baseDir, ".flywheel", "agent-outputs", "session-foreign");
    fs.mkdirSync(dir, { recursive: true });
    const foreign = path.join(dir, "notes.txt");
    fs.writeFileSync(foreign, "someone else's file");

    sweepBreadcrumbs(baseDir, NOW + 1_000 * DAY_MS);

    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("isolates an unsafe entry and still removes expired safe breadcrumbs", () => {
    const unsafeDir = path.join(baseDir, ".flywheel", "agent-outputs", "a-unsafe");
    fs.mkdirSync(unsafeDir, { recursive: true });
    fs.writeFileSync(path.join(outside, "evidence.txt"), "not ours");
    fs.symlinkSync(outside, path.join(unsafeDir, "search_2026-01-01T00-00-00-000Z_abc123.txt"));
    const expired = plant("z-safe", NOW - 8 * DAY_MS);

    sweepBreadcrumbs(baseDir, NOW);

    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "evidence.txt"), "utf8")).toBe("not ours");
  });

  it("runs one pass per project per cadence window", async () => {
    const first = plant("session-a", Date.now() - 8 * DAY_MS);
    const maintenance = createBreadcrumbMaintenance(baseDir);
    maintenance.request();
    maintenance.request();
    await Promise.resolve();
    expect(fs.existsSync(first)).toBe(false);

    // Inside the window the coordinator declines: the next completion pays for
    // the next pass, not this one.
    const second = plant("session-b", Date.now() - 8 * DAY_MS);
    maintenance.request();
    await Promise.resolve();
    expect(fs.existsSync(second)).toBe(true);
  });
});