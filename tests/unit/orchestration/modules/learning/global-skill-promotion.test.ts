import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";

import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore, type StoredFact } from "../../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { createSkillManageTool } from "../../../../../src/orchestration/modules/learning/tools/skill-manage.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { loadAgentInputProjection } from "../../../../../src/orchestration/session/agent-input-projection.js";
import { createSessionFactWriter, type SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import type { SkillWriteOrigin } from "../../../../../src/orchestration/modules/learning/skill-store-types.js";
import type { SkillDefinition } from "../../../../../src/workflows/skill-schema.js";
import { publishSkillRevision, SKILL_FILE } from "../../../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../../../src/workflows/skills.js";
import { operationIdentity, readOperationManifest } from "../../../../../src/orchestration/modules/learning/skill-operation-manifest.js";
import { planSkillMutation } from "../../../../../src/orchestration/modules/learning/skill-mutation-plan.js";
import { publishGlobalSkillMutation } from "../../../../../src/orchestration/modules/learning/global-skill-mutation.js";

const TMP = fileTemporaryDirectory("flywheel-global-promotion-test-");
const CWD = join(TMP, "project");
const HOME = join(TMP, "home");
// The directory authorities of this test's project and account state (ARCH-DIRECTORIES-001).
const DIRS = { projectRoot: CWD, accountHome: HOME, userDataRoot: join(HOME, ".flywheel") };
const SHARED = join(TMP, "shared");
const SESSION = "sess-promote";
const AGENT: SkillWriteOrigin = { kind: "agent", sessionId: SESSION };
const NAME = "deploy-runbook";

let store: LocalSqliteEventStore;
let writer: SessionFactWriter;

function roots() {
  return ownedSkillStoreDirs(DIRS);
}

function registry() {
  const dirs = roots();
  const load = loadSkillDefinitions({
    roots: [
      { authority: "external", dir: dirs.project, reach: "project" },
      { authority: "external", dir: dirs.user, reach: "global" },
      { authority: "external", dir: SHARED, reach: "global" },
    ],
  });
  return publishSkillRevision(1, load.skills);
}

function selected(name: string): SkillDefinition | undefined {
  return registry().skills.get(name);
}

function packageDirOf(name: string): string | undefined {
  const source = selected(name)?.source;
  return source?.kind === "filesystem" ? source.packageDir : undefined;
}

function skillManage(origin: SkillWriteOrigin = AGENT) {
  return createSkillManageTool({ origin, registry, userDataRoot: DIRS.userDataRoot, store: asAsyncEventReadSurface(store), sessionId: SESSION });
}

function context(toolUseId: string): ToolContext {
  return { executionCwd: CWD, userDataRoot: `${CWD}/.test-account`, projectRoot: CWD, toolUseId, artifactScopeId: SESSION, retrievalSessionId: SESSION, sessionId: SESSION, conversationId: "conv-1", sessionEventWriter: writer };
}

/** The audit trail of landed writes in this session. */
function writtenFacts(): StoredFact[] {
  return [...store.read({ aggregateId: `session:${SESSION}`, types: ["skill.written"] })];
}

function installPackage(root: string, name: string, body: string, managed = "flywheel"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE), `---\ndescription: Use when running the ${name} procedure.\nmanaged: ${managed}\nprovenance:\n  createdBy: "sess-origin"\n  updatedBy: "sess-origin"\n---\n${body}\n`);
  return dir;
}

function installProjectPackage(body = "Step one."): string {
  const dir = installPackage(roots().project, NAME, body);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "references", "note.md"), "Reference note.\n");
  return dir;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  store = createSqliteEventStore(join(TMP, "flywheel.sqlite"));
  writer = createSessionFactWriter({ sessionId: SESSION, writer: asAsyncEventWriter(store) });
});

afterEach(() => {
  writer.dispose();
  store.close();
});

describe("promotion is an interactive global mutation", () => {
  it("promotes in one call without a question", async () => {
    installProjectPackage();

    const result = await skillManage().execute({ action: "promote", name: NAME }, context("call-1"));

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("Reach: global");
    expect(existsSync(join(roots().project, NAME))).toBe(false);
    expect(packageDirOf(NAME)).toBe(join(roots().user, NAME));
    expect((await loadAgentInputProjection(asAsyncEventReadSurface(store), SESSION)).size).toBe(0);
  });

  it("publishes the global package and leaves no project copy", async () => {
    installProjectPackage();
    const result = await skillManage().execute({ action: "promote", name: NAME }, context("call-commit"));

    expect(result.outcome).toBe("ok");
    const globalDir = join(roots().user, NAME);
    expect(readFileSync(join(globalDir, SKILL_FILE), "utf8")).toContain('createdBy: "sess-origin"');
    expect(readFileSync(join(globalDir, "references", "note.md"), "utf8")).toBe("Reference note.\n");
    expect(existsSync(join(roots().project, NAME))).toBe(false);
    expect(packageDirOf(NAME)).toBe(globalDir);
    await writer.flush?.();
    expect(JSON.stringify(writtenFacts())).toContain('"action":"promoted"');
  });

  it("retains the promotion diff in the operation as a source deletion and a destination addition", async () => {
    installProjectPackage();
    const config = { projectRoot: CWD, userDataRoot: DIRS.userDataRoot, registry };
    const planned = planSkillMutation(config, AGENT, { kind: "promote", name: NAME });
    if (planned.kind === "refused") throw new Error(planned.error);
    expect((await skillManage().execute({ action: "promote", name: NAME }, context("call-promote"))).outcome).toBe("ok");
    const read = readOperationManifest(roots().user, operationIdentity({ sessionId: SESSION, interactionId: "call-promote" }, planned.plan.proposalId));
    if (read.kind !== "ok") throw new Error(`expected a usable operation: ${JSON.stringify(read)}`);

    // The record decodes strictly and is fully reverified, so the diff it
    // carries is the one the planner captured, whole. The store resolves a live
    // package through its canonical directory, so the diff of a temporary tree
    // names the realpath.
    const underTmp = (path: string): string => path.replace(realpathSync(TMP), TMP);
    expect(read.manifest.plan.diff.files.map((file) => [underTmp(file.path), file.change])).toEqual([
      [join(roots().project, NAME, SKILL_FILE), "removed"],
      [join(roots().user, NAME, SKILL_FILE), "added"],
      [join(roots().project, NAME, "references/note.md"), "removed"],
      [join(roots().user, NAME, "references/note.md"), "added"],
    ]);
  });

  it("refuses publication when a package byte changed after planning", async () => {
    const projectDir = installProjectPackage();
    const config = { projectRoot: CWD, userDataRoot: DIRS.userDataRoot, registry };
    const planned = planSkillMutation(config, AGENT, { kind: "promote", name: NAME });
    if (planned.kind === "refused") throw new Error(planned.error);
    writeFileSync(join(projectDir, "references", "note.md"), "Edited note.\n");

    const result = await publishGlobalSkillMutation({ config, origin: AGENT, plan: planned.plan, sessionId: SESSION, toolUseId: "call-promote", store: asAsyncEventReadSurface(store), writer, openAudit: () => undefined });

    expect(result.kind).toBe("refused");
    expect(existsSync(join(roots().user, NAME))).toBe(false);
    expect(packageDirOf(NAME)).toBe(projectDir);
  });
});

describe("promotion refuses every same-id conflict", () => {
  it("refuses an existing global name without changing either package", async () => {
    installProjectPackage("Project step.");
    installPackage(roots().user, NAME, "Global step.");

    const result = await skillManage().execute({ action: "promote", name: NAME }, context("call-1"));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("distinct id");
    expect(readFileSync(join(roots().project, NAME, SKILL_FILE), "utf8")).toContain("Project step.");
    expect(readFileSync(join(roots().user, NAME, SKILL_FILE), "utf8")).toContain("Global step.");
  });

  it("refuses a project package that already shadows another installed package", async () => {
    installProjectPackage("Project step.");
    installPackage(SHARED, NAME, "Shared step.");

    const result = await skillManage().execute({ action: "promote", name: NAME }, context("call-1"));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("shadows");
    expect(existsSync(join(roots().user, NAME))).toBe(false);
  });

  it("refuses a source that is not a project package", async () => {
    installPackage(roots().user, NAME, "Global step.");

    const result = await skillManage().execute({ action: "promote", name: NAME }, context("call-1"));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("already a global package");
  });

  it("refuses a promotion from the background review origin", async () => {
    installProjectPackage();
    const review: SkillWriteOrigin = { kind: "review", reviewRunId: "rev-1", loadedSkillIds: new Set([NAME]) };

    const result = await skillManage(review).execute({ action: "promote", name: NAME }, context("call-review"));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("no autonomous actor may create or change global skills");
    expect(existsSync(join(roots().user, NAME))).toBe(false);
    expect(packageDirOf(NAME)).toBe(join(roots().project, NAME));
  });
});
