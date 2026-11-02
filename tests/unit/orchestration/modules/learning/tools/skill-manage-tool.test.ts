import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SessionNoticeOperation } from "../../../../../../src/infra/session-notice.js";
import { readMutationEvidenceFiles } from "../../../../../../src/infra/mutation-evidence.js";
import { MutationEvidenceSchema } from "../../../../../../src/infra/mutation-evidence-schema.js";
import { readSessionContentRange, type SessionContentNode } from "../../../../../../src/infra/session-content.js";
import { resolveToolPresentation } from "../../../../../../src/infra/tools/tool-display-registry.js";
import { createSkillManageTool, type SkillManageToolDeps } from "../../../../../../src/orchestration/modules/learning/tools/skill-manage.js";
import type { CapabilityAccess, RuntimeTool, ToolContext } from "../../../../../../src/orchestration/agent-runtime/tools/types.js";
import { executePreparedTool, prepareToolCall } from "../../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { capabilityAccessHolding, makeContext as makeToolContext, testGrant } from "../../../agent-runtime/tools/_fixtures.js";
import { publishSkillRevision } from "../../../../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../../../../src/workflows/skills.js";
import { parseSkillFact } from "../../../../../../src/workflows/skill-facts.js";
import { fileTemporaryDirectory } from "../../../../../helpers/directories.js";

const TMP = fileTemporaryDirectory("flywheel-skill-manage-tool-test-");
const CWD = join(TMP, "project");
const HOME = join(TMP, "home");
// The directory authorities of this test's project and account state (ARCH-DIRECTORIES-001).
const DIRS = { projectRoot: CWD, accountHome: HOME, userDataRoot: join(HOME, ".flywheel") };

let recorded: Array<{ type: string; payload: { [key: string]: unknown } }> = [];
let notices: SessionNoticeOperation[] = [];
let contentNodes = new Map<string, SessionContentNode>();

function registry() {
  const dirs = ownedSkillStoreDirs(DIRS);
  const load = loadSkillDefinitions({
    roots: [
      { authority: "external", dir: dirs.project, reach: "project" },
      { authority: "external", dir: dirs.user, reach: "global" },
    ],
  });
  return publishSkillRevision(1, load.skills);
}

function verifiedCandidate(candidate: import("../../../../../../src/orchestration/agent-runtime/review-types.js").PreparedPackage, revision = registry()) {
  return Promise.resolve({
    kind: "verified" as const,
    evidence: {
      candidateIdentity: candidate.identity,
      registryRevision: revision.revision,
      outcome: { outcome: "independent" as const },
    },
  });
}

function makeTool(publishDefinitions?: SkillManageToolDeps["publishDefinitions"]): ReturnType<typeof createSkillManageTool> {
  const deps = {
    origin: { kind: "agent" as const, sessionId: "sess-1" },
    registry,
    userDataRoot: DIRS.userDataRoot,
    ...(publishDefinitions ? { publishDefinitions } : {}),
    onNotice: (operation: SessionNoticeOperation) => notices.push(operation),
  };
  return createSkillManageTool(deps);
}

// A writer that resolves null wrote nothing, which the tool treats as a failed
// audit record, so the accepting fake resolves a stored-event stand-in.
function makeContext(): ToolContext {
  return makeToolContext({
    executionCwd: CWD,
    projectRoot: CWD,
    sessionId: "sess-1",
    toolUseId: "tool-global-test",
    sessionEventWriter: {
      stageSessionContentNodes: async (nodes) => { for (const row of nodes) contentNodes.set(row.sha256, row.node); },
      record: (fact) => {
        recorded.push(parseSkillFact(fact));
        return Promise.resolve({ position: recorded.length, id: `evt-${recorded.length}`, aggregateId: "session:sess-1", sessionId: "sess-1", seq: recorded.length, timestamp: 0, type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload });
      },
      recordBatch: async () => { throw new Error("unexpected batch write"); },
      recordGuarded: async () => { throw new Error("unexpected guarded write"); },
      transaction: async (run) => { run(); },
      dispose: () => {},
    },
  });
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  recorded = [];
  notices = [];
  contentNodes = new Map();
});

describe("skill_manage tool", () => {
  it("saves a skill, publishes it before returning, emits the fact without a status notice, and reports terminal completion", async () => {
    const installedAtPublish: boolean[] = [];
    const tool = makeTool(async () => {
      installedAtPublish.push(existsSync(join(CWD, ".flywheel", "skills", "provider-quirks", "SKILL.md")));
      return { published: true, revision: 2, skills: 1 };
    });
    const result = await tool.execute({
      action: "save",
      name: "provider-quirks",
      description: "Use when handling provider quirks.",
      body: "# Quirks\n\nHandle them.",
      reach: "project",
    }, makeContext());

    expect(result.outcome).toBe("ok");
    expect(installedAtPublish).toEqual([true]);
    expect(result.content).toContain("The change is live in this project's skill catalog now. Other open projects see it when their skill watcher reports the change.");
    expect(result.content).toContain("do not repeat");
    expect(existsSync(join(CWD, ".flywheel", "skills", "provider-quirks", "SKILL.md"))).toBe(true);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.type).toBe("skill.written");
    expect(recorded[0]?.payload.action).toBe("created");
    expect(recorded[0]?.payload.reach).toBe("project");
    expect(recorded[0]?.payload.origin).toEqual({ kind: "agent", sessionId: "sess-1" });
    // Identity is the audit trail: this one write, the content-bound proposal it
    // applied, and the exact bytes it left behind.
    expect(recorded[0]?.payload.identity).toMatchObject({
      kind: "recorded",
      writeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      proposalId: expect.stringMatching(/^[0-9a-f]{64}$/),
      packageIdentity: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(notices).toHaveLength(0);
  });

  it("reports a landed write without claiming it is live when this process cannot confirm its publication", async () => {
    const cases: Array<SkillManageToolDeps["publishDefinitions"]> = [
      undefined,
      async () => ({ published: false, revision: 1, skills: 0 }),
      async () => undefined,
      async () => { throw new Error("reconciliation failed"); },
    ];
    for (const [index, publish] of cases.entries()) {
      const result = await makeTool(publish).execute({ action: "save", name: `unpublished-${index}`, description: "Use for unpublished work.", body: "Body.", reach: "project" }, makeContext());
      expect(result.outcome).toBe("ok");
      expect(result.content).not.toContain("live in this project");
      expect(result.content).toContain("could not confirm the change");
      expect(result.content).toContain("do not repeat");
    }
  });

  it("patches through the tool surface", async () => {
    const tool = makeTool();
    await tool.execute({ action: "save", name: "umbrella", description: "Use for umbrella work.", body: "Original body.", reach: "project" }, makeContext());

    const result = await tool.execute({ action: "patch", name: "umbrella", old_string: "Original body.", new_string: "Patched body." }, makeContext());

    expect(result.outcome).toBe("ok");
    expect(recorded.at(-1)?.payload.action).toBe("patched");
  });

  it("returns the store refusal verbatim with no fact and no notice", async () => {
    const tool = makeTool();
    const result = await tool.execute({ action: "archive", name: "not-installed" }, makeContext());

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("not installed");
    expect(recorded).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });


  it("mutates the package the row names: one normalization of a noncanonical name", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      action: "save",
      name: " Provider-Quirks ",
      description: "Use when handling provider quirks.",
      body: "# Quirks",
      reach: "project",
    }, makeContext());

    expect(result.outcome).toBe("ok");
    expect(existsSync(join(CWD, ".flywheel", "skills", "provider-quirks", "SKILL.md"))).toBe(true);
    expect(recorded[0]?.payload.name).toBe("provider-quirks");
    // The row a user reads is resolved from the same raw input, through the
    // same normalization, so it names exactly this package.
    expect(resolveToolPresentation("skill_manage", { action: "save", name: " Provider-Quirks " }, CWD))
      .toEqual({ name: "Save Skill", detail: "provider-quirks" });
  });

  it("refuses a name that is not a package id at all", async () => {
    const tool = makeTool();
    const result = await tool.execute({ action: "save", name: "Raw body: not a slug", description: "d", body: "b" }, makeContext());

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("lowercase, class-level slug");
    expect(recorded).toHaveLength(0);
  });
});

  it("applies global changes in one call without Ask User and identifies their reach", async () => {
    const tool = createSkillManageTool({
      origin: { kind: "agent", sessionId: "sess-1" },
      registry,
      userDataRoot: DIRS.userDataRoot,
    });

    const result = await tool.execute({
      action: "save",
      name: "global-runbook",
      description: "Use for global runbook work.",
      body: "# Runbook",
      reach: "global",
    }, makeContext());

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("Reach: global.");
    expect(existsSync(join(DIRS.userDataRoot, "skills", "global-runbook", "SKILL.md"))).toBe(true);
    expect(recorded.at(-1)?.payload.reach).toBe("global");
  });

describe("skill_manage review-origin facts", () => {
  it("records the fact origin without the runtime-only read marks", async () => {
    const tool = createSkillManageTool({
      origin: { kind: "review", reviewRunId: "rev-9", loadedSkillIds: new Set(["x"]) },
      registry,
      userDataRoot: DIRS.userDataRoot,
      onCandidate: verifiedCandidate,
    });
    await tool.execute({ action: "save", name: "review-made", description: "Use for review-made work.", body: "Body.", reach: "project" }, makeContext());

    expect(recorded[0]?.payload.origin).toEqual({ kind: "review", reviewRunId: "rev-9" });
  });

  it("supplies the exact prepared candidate before publication", async () => {
    let candidate: import("../../../../../../src/orchestration/agent-runtime/review-types.js").PreparedPackage | undefined;
    let existedDuringCallback = true;
    const tool = createSkillManageTool({
      origin: { kind: "review", reviewRunId: "rev-9", loadedSkillIds: new Set() },
      registry,
      userDataRoot: DIRS.userDataRoot,
      onCandidate: async (prepared, revision) => {
        candidate = prepared;
        existedDuringCallback = existsSync(join(CWD, ".flywheel", "skills", "candidate", "SKILL.md"));
        return verifiedCandidate(prepared, revision);
      },
    });

    await tool.execute({ action: "save", name: "candidate", description: "Use for candidate work.", body: "Body.", reach: "project" }, makeContext());

    expect(existedDuringCallback).toBe(false);
    expect(candidate?.files).toHaveLength(1);
    expect(candidate?.files[0]?.path).toBe("SKILL.md");
    expect(candidate?.files[0]?.content).toContain("Use for candidate work.");
    expect(candidate?.identity.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats callback completion without verified evidence as no authority to write", async () => {
    const tool = createSkillManageTool({
      origin: { kind: "review", reviewRunId: "rev-9", loadedSkillIds: new Set() },
      registry,
      userDataRoot: DIRS.userDataRoot,
      onCandidate: async () => ({ kind: "uncertain", reason: "the test auditor declines" }),
    });

    const result = await tool.execute({ action: "save", name: "uncertain", description: "Use for uncertain work.", body: "Body.", reach: "project" }, makeContext());

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("was not admitted: the test auditor declines");
    expect(existsSync(join(CWD, ".flywheel", "skills", "uncertain"))).toBe(false);
    expect(existsSync(join(CWD, ".flywheel", "skills", ".operations", "audit"))).toBe(false);
    expect(recorded).toHaveLength(0);
  });
});

  it("refuses a review-origin global mutation before semantic audit", async () => {
    let audits = 0;
    const tool = createSkillManageTool({
      origin: { kind: "review", reviewRunId: "rev-9", loadedSkillIds: new Set() },
      registry,
      userDataRoot: DIRS.userDataRoot,
      onCandidate: async () => { audits += 1; return { kind: "uncertain", reason: "the test auditor declines" }; },
    });
    const result = await tool.execute({ action: "save", name: "global-review", description: "Use for global review work.", body: "Body.", reach: "global" }, makeContext());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("no autonomous actor may create or change global skills");
    expect(audits).toBe(0);
  });


describe("skill_manage recommend action", () => {
  it("refuses a recommendation from an interactive origin and names the decision path", async () => {
    const tool = makeTool();
    await tool.execute({ action: "save", name: "runbook", description: "Use for runbook work.", body: "Body.", reach: "project" }, makeContext());
    recorded = [];

    const result = await tool.execute({ action: "recommend", name: "runbook" }, makeContext());

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("promote");
    expect(result.content).not.toContain("confirmation_id");
    expect(result.content).toContain("apply the promotion now");
    expect(recorded).toHaveLength(0);
  });

  it("records a review recommendation with the promotion identity and writes nothing", async () => {
    const recommendations: Array<{ recommendationId: string; name: string; reach: string }> = [];
    const tool = createSkillManageTool({
      origin: { kind: "review", reviewRunId: "rev-9", loadedSkillIds: new Set<string>() },
      registry,
      userDataRoot: DIRS.userDataRoot,
      onRecommended: (recommendation) => recommendations.push(recommendation),
      onCandidate: verifiedCandidate,
    });
    await tool.execute({ action: "save", name: "runbook", description: "Use for runbook work.", body: "Body.", reach: "project" }, makeContext());
    recorded = [];

    const result = await tool.execute({ action: "recommend", name: "runbook" }, makeContext());

    expect(result.outcome).toBe("ok");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.type).toBe("skill.recommendation.recorded");
    expect(recorded[0]?.payload.reach).toBe("global");
    expect(recorded[0]?.payload.action).toBe("promote");
    expect(recorded[0]?.payload.origin).toEqual({ kind: "review", reviewRunId: "rev-9" });
    expect(recommendations).toHaveLength(1);
    expect(result.content).toContain(String(recommendations[0]?.recommendationId));
    // Nothing global moved: the project package is still the only copy.
    expect(existsSync(join(CWD, ".flywheel", "skills", "runbook", "SKILL.md"))).toBe(true);
    expect(existsSync(join(HOME, ".flywheel", "skills", "runbook"))).toBe(false);
  });
});

describe("skill_manage mutation artifact", () => {
  it("carries reference-only display evidence without project file facts", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      action: "save",
      name: "artifact-carrier",
      description: "Use for artifact work.",
      body: "# Body\n\nWritten once.",
      reach: "project",
    }, makeContext());

    expect(result.outcome).toBe("ok");
    const details = result.details;
    if (typeof details !== "object" || details === null || Array.isArray(details) || !("mutationEvidence" in details) || !("resultAction" in details)) throw new Error("mutation evidence details are missing");
    expect(details.resultAction).toBe("created");
    const evidence = Schema.decodeUnknownSync(MutationEvidenceSchema)(details.mutationEvidence);
    expect(evidence.omissions).toBe(0);
    const read = async (hash: string) => contentNodes.get(hash) ?? null;
    const page = await readMutationEvidenceFiles(evidence, 0, 10, read);
    if (page.kind !== "available") throw new Error("file evidence is unavailable");
    const entry = page.files[0];
    if (entry?.kind !== "display" || entry.file.patch.kind !== "retained") throw new Error("patch is unavailable");
    expect("before" in entry.file).toBe(false);
    expect("after" in entry.file).toBe(false);
    expect(entry.file.path).toEndWith("SKILL.md");
    expect(entry.file.change).toBe("added");
    const range = await readSessionContentRange(entry.file.patch.reference, 0, 65536, read);
    if (range.kind !== "available") throw new Error("patch bytes are unavailable");
    expect(Buffer.from(range.base64, "base64").toString()).toContain("Written once.");
    expect(JSON.stringify(details)).not.toContain("Written once.");
    expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThan(4096);
    expect(recorded.map(fact => fact.type)).toEqual(["skill.written"]);
  });

  it("reports unavailable display storage without repeating or undoing the landed skill write", async () => {
    const context = makeContext();
    context.sessionEventWriter!.stageSessionContentNodes = async () => { throw new Error("disk unavailable"); };
    const result = await makeTool().execute({ action: "save", name: "saved-skill", description: "Use for saved work.", body: "Saved body.", reach: "project" }, context);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Change evidence is unavailable");
    expect(result.content).toContain("do not repeat it");
    expect(existsSync(join(CWD, ".flywheel", "skills", "saved-skill", "SKILL.md"))).toBe(true);
    expect(recorded.map(fact => fact.type)).toEqual(["skill.written"]);
  });

  it("carries no artifact when the store refuses the mutation", async () => {
    const tool = makeTool();
    const result = await tool.execute({ action: "archive", name: "not-installed" }, makeContext());

    expect(result.outcome).toBe("error");
    expect(result.details).toBeUndefined();
  });
});

/** The capability boundary one managed-skill write passes (ARCH-TOOLS-001). Managed
 *  mutation needs Learning and Skills together, and the gate is the shared
 *  dispatcher, so these cases drive the real prepare-plus-execute path. */
describe("skill_manage under capability policy", () => {
  const SAVE = {
    action: "save",
    name: "provider-quirks",
    description: "Use when handling provider quirks.",
    body: "# Quirks\n\nHandle them.",
    reach: "project",
  };

  function packageFile(): string {
    return join(CWD, ".flywheel", "skills", "provider-quirks", "SKILL.md");
  }

  function dispatch(capabilityAccess: CapabilityAccess): Promise<{ outcome: string; content: unknown }> {
    const tools = new Map<string, RuntimeTool>([["skill_manage", makeTool()]]);
    const prepared = prepareToolCall({ id: "skill-manage-call", name: "skill_manage", input: SAVE }, tools);
    return executePreparedTool(prepared, { ...makeContext(), capabilityAccess });
  }

  it("refuses a stale call before the package is written", async () => {
    const result = await dispatch(capabilityAccessHolding(["skills"]));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("learning is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml");
    expect(existsSync(packageFile())).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it("writes for an admitted review whose grant outlives the disable", async () => {
    const result = await dispatch(capabilityAccessHolding([], testGrant("the self-improvement review", ["learning", "skills"])));

    expect(result.outcome).toBe("ok");
    expect(existsSync(packageFile())).toBe(true);
  });
});
