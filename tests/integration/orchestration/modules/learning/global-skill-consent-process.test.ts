/** The confirmed global mutation protocol across processes.
 *
 *  The operation is prepared by the production path and confirmed by a
 *  recorded decision; two real processes then race to claim and publish it
 *  over one event store and one global skill store. Crash recovery in one
 *  process is in the unit tier. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import type { SkillMutation } from "../../../../../src/orchestration/modules/learning/skill-store-types.js";
import { SKILL_FILE } from "../../../../../src/workflows/skill-schema.js";
import { createGlobalSkillHarness, type GlobalSkillHarness } from "../../../../helpers/global-skill-operations.js";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
// A manifest names its directories canonically, and recovery compares them
// canonically, so the fixture root is symlink-resolved (on macOS the temporary
// directory is a link under /private) before any path is derived from it.
const TMP = join(realpathSync(tmpdir()), `flywheel-global-consent-process-${randomUUID()}`);
const CWD = join(TMP, "project");
const HOME = join(TMP, "home");
// The directory authorities of this fixture's project and account state (ARCH-DIRECTORIES-001).
const DIRS = { projectRoot: CWD, accountHome: HOME, userDataRoot: join(HOME, ".flywheel") };
const DB = join(TMP, "flywheel.sqlite");
const SESSION = "sess-process";
const NAME = "global-notes";
const INTERACTION = "ask-1";
/** The outcome line a commit worker prints. */
const decodeOutcome = Schema.decodeUnknownSync(Schema.Struct({ kind: Schema.String }));

const MUTATION: SkillMutation = {
  kind: "save",
  name: NAME,
  description: "Use for global notes, revised.",
  body: "Revised body.",
};

let harness: GlobalSkillHarness;

function packageDir(): string {
  return join(harness.globalRoot, NAME);
}

function installedBody(): string {
  return readFileSync(join(packageDir(), SKILL_FILE), "utf8");
}

function installGlobalSkill(body: string): void {
  mkdirSync(packageDir(), { recursive: true });
  writeFileSync(join(packageDir(), SKILL_FILE), `---\ndescription: Use for global notes.\nmanaged: flywheel\n---\n${body}\n`);
}

const WORKER = `
import ${JSON.stringify(pathToFileURL(join(REPO, "src/orchestration/modules.js")).href)};
import { createSqliteEventStore } from ${JSON.stringify(pathToFileURL(join(REPO, "src/infra/sqlite-event-store.js")).href)};
import { createSessionFactWriter } from ${JSON.stringify(pathToFileURL(join(REPO, "src/orchestration/session/session-fact-writer.js")).href)};
import { commitGlobalSkillMutation } from ${JSON.stringify(pathToFileURL(join(REPO, "tests/helpers/global-skill-operations.js")).href)};
import { writeFileSync } from "node:fs";
import { publishSkillRevision } from ${JSON.stringify(pathToFileURL(join(REPO, "src/workflows/skill-schema.js")).href)};
import { loadSkillDefinitions, ownedSkillStoreDirs } from ${JSON.stringify(pathToFileURL(join(REPO, "src/workflows/skills.js")).href)};

const registry = () => {
  const dirs = ownedSkillStoreDirs(${JSON.stringify(DIRS)});
  const load = loadSkillDefinitions({ roots: [{ authority: "external", dir: dirs.project, reach: "project" }, { authority: "external", dir: dirs.user, reach: "global" }] });
  return publishSkillRevision(1, load.skills);
};
const store = createSqliteEventStore(${JSON.stringify(DB)});
const writer = createSessionFactWriter({ sessionId: ${JSON.stringify(SESSION)}, writer: store });
const result = await commitGlobalSkillMutation({
  config: { projectRoot: ${JSON.stringify(CWD)}, userDataRoot: ${JSON.stringify(DIRS.userDataRoot)}, registry },
  origin: { kind: "agent", sessionId: ${JSON.stringify(SESSION)} },
  mutation: ${JSON.stringify(MUTATION)},
  sessionId: ${JSON.stringify(SESSION)},
  interactionId: ${JSON.stringify(INTERACTION)},
  store,
  writer,
  beforeClaim: async () => {
    writeFileSync(process.argv[2], "");
    await Bun.stdin.text();
  },
});
writer.dispose();
store.close();
console.log(JSON.stringify(result));
`;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  harness = createGlobalSkillHarness({ directories: DIRS, dbPath: DB, sessionId: SESSION });
  installGlobalSkill("Alpha.");
});

afterEach(() => {
  harness.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("two processes over one event store and one global skill store", () => {
  it("publishes the confirmed mutation once", async () => {
    const mutationId = harness.prepare(MUTATION);
    await harness.approve(mutationId, INTERACTION);
    const script = join(TMP, "commit-worker.ts");
    writeFileSync(script, WORKER);

    // Both workers plan against the confirmed pre-state before either claims.
    // A worker that plans while the other has the package hidden mid-publication
    // plans a different proposal, and process starts skew enough on Windows to
    // land there; the race under test is the claim and the publication.
    const workers = [0, 1].map((index) => {
      const planned = join(TMP, `planned-${index}`);
      return { planned, child: Bun.spawn(["bun", script, planned], { cwd: REPO, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true }) };
    });
    while (!workers.every(({ planned, child }) => child.exitCode !== null || existsSync(planned))) await Bun.sleep(10);
    for (const { child } of workers) child.stdin.end();
    const runs = await Promise.all(workers.map(async ({ child }) => ({ code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })));

    // The worker logs to stderr, so its exit code is the outcome; a failure
    // surfaces the captured output.
    for (const run of runs) expect(run.code === 0 ? "" : run.err).toBe("");
    const outcomes = runs.map((run) => decodeOutcome(JSON.parse(run.out.trim())));
    expect(outcomes.map((outcome) => outcome.kind), runs.map((run) => run.out).join("\n")).toEqual(["written", "written"]);
    expect(harness.consumedClaimCount()).toBe(1);
    expect(installedBody()).toContain("Revised body.");
  }, 30_000);
});
