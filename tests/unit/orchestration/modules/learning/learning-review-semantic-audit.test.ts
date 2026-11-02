import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { createSkillManageTool } from "../../../../../src/orchestration/modules/learning/tools/skill-manage.js";
import { capabilityAccessFor, type ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { composeRealmModuleSnapshot } from "../../../../../src/orchestration/modules.js";
import { createLearningReview } from "../../../../../src/orchestration/modules/learning/learning-review.js";
import { verifySkillSemanticAudit } from "../../../../../src/orchestration/modules/learning/skill-semantic-audit.js";
import { BUNDLED_SKILL_DIR } from "../../../../../src/workflows/skill-source-inventory.js";
import { renderSkillClosure } from "../../../../../src/workflows/skill-context.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../../../src/workflows/skills.js";
import { publishSkillRevision, SKILL_FILE, type SkillRegistryRevision } from "../../../../../src/workflows/skill-schema.js";
import type { SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import type { AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js";
import { makeContext, testGrant } from "../../agent-runtime/tools/_fixtures.js";
import { sessionContentFixture } from "../../../../helpers/session-content.js";
import { readMutationEvidenceFiles } from "../../../../../src/infra/mutation-evidence.js";

const ROOT = join(tmpdir(), `flywheel-learning-review-semantic-audit-${randomUUID()}`);
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
const state = {
  capabilities: ["skills", "learning"] as const,
  moduleIds: ["skills", "learning"] as const,
  requireWorkflowConfirmation: true,
  workflowsMode: "off" as const,
  identity: "skills+learning",
};
const capabilities = capabilityAccessFor({
  state: () => state,
  admit: async (request) => ({ ok: true, grant: testGrant(request.operation, request.required, state.capabilities) }),
});

function loadRegistry(projectRoot: string, userDataRoot: string, revision = 1): SkillRegistryRevision {
  const dirs = ownedSkillStoreDirs({ projectRoot, userDataRoot });
  const loaded = loadSkillDefinitions({ roots: [
    { authority: "external", dir: dirs.project, reach: "project" },
    { authority: "external", dir: dirs.user, reach: "global" },
    { authority: "bundled" as const, dir: BUNDLED_SKILL_DIR, reach: "global" as const, sourceKind: "agent" as const },
  ] });
  return publishSkillRevision(revision, loaded.skills, loaded.bundledCorpus);
}

interface ScenarioOptions {
  readonly output: string;
  readonly dependencies?: readonly string[];
  readonly contextLimit?: number;
  readonly action?: "save" | "restore";
  readonly setup?: (projectRoot: string, userDataRoot: string) => void;
  readonly afterAudit?: (projectRoot: string, setRegistry: (revision: SkillRegistryRevision) => void, pinned: SkillRegistryRevision) => void;
}

interface ScenarioResult {
  readonly projectRoot: string;
  readonly userDataRoot: string;
  readonly facts: readonly string[];
  readonly actions: readonly string[];
  readonly recommendations: readonly string[];
  readonly notifications: readonly string[];
  readonly childRuns: number;
  readonly result: ToolResult;
}

async function runScenario(name: string, options: ScenarioOptions): Promise<ScenarioResult> {
  const projectRoot = join(ROOT, name);
  const userDataRoot = join(ROOT, "home", ".flywheel");
  mkdirSync(projectRoot, { recursive: true });
  options.setup?.(projectRoot, userDataRoot);
  const facts: string[] = [];
  const actions: string[] = [];
  const recommendations: string[] = [];
  const notifications: string[] = [];
  let childRuns = 0;
  let currentRegistry = loadRegistry(projectRoot, userDataRoot);
  let position = 0;
  const { stage, read } = sessionContentFixture();
  const writer: SessionFactWriter = {
    stageSessionContentNodes: stage,
    recordBatch: async () => null,
    record: async (fact) => {
      facts.push(fact.type);
      position += 1;
      return { aggregateId: `session:session-${name}`, type: fact.type, version: fact.version, timestamp: Date.now(), actor: fact.actor, sessionId: `session-${name}`, payload: fact.payload, position, id: `event-${position}`, seq: position };
    },
    recordGuarded: async (fact) => {
      position += 1;
      return { kind: "stored", events: [{ aggregateId: `session:session-${name}`, type: fact.type, version: fact.version, timestamp: Date.now(), actor: fact.actor, sessionId: `session-${name}`, payload: fact.payload, position, id: `event-${position}`, seq: position }] };
    },
    transaction: async (operation) => { operation(); },
    dispose: () => {},
  };
  let result: ToolResult = { outcome: "error", content: "not run" };
  let done: Promise<AgentRunResult> = Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } });
  const review = createLearningReview({
    sessionId: `session-${name}`,
    config: { memoryIntervalTurns: 0, skillIntervalIterations: 1, notifications: "verbose" },
    capabilities,
    moduleSelection: () => composeRealmModuleSnapshot({ moduleIds: state.capabilities }),
    sessionEventWriter: writer,
    readContentNode: read,
    spawnReview: async (spec) => {
      const audit = (candidate: import("../../../../../src/orchestration/agent-runtime/review-types.js").PreparedPackage, revision: SkillRegistryRevision) => {
        if ((options.contextLimit ?? 100_000) <= 1_024) return Promise.resolve({ kind: "uncertain" as const, reason: "the test context limit refuses the audit" });
        childRuns += 1;
        return Promise.resolve(verifySkillSemanticAudit(candidate, revision, options.output));
      };
      const tool = createSkillManageTool({
        origin: { kind: "review", reviewRunId: spec.reviewRunId, loadedSkillIds: new Set() },
        registry: () => currentRegistry,
        userDataRoot,
        onCandidate: async (candidate, revision) => {
          const audited = await audit(candidate, revision);
          options.afterAudit?.(projectRoot, (next) => { currentRegistry = next; }, revision);
          return audited;
        },
        onWritten: (action) => spec.learningReview.onWritten({ surface: "skill", ...action }),
        onRecommended: spec.learningReview.onRecommended,
      });
      const input = options.action === "restore"
        ? { action: "restore", name, reach: "project" }
        : { action: "save", name, description: `Use for ${name} work.`, body: `# ${name}\n\nProject-specific delta.`, dependencies: options.dependencies ?? [], reach: "project" };
      done = tool.execute(input, makeContext({ projectRoot, executionCwd: projectRoot, sessionEventWriter: writer })).then((value) => {
        result = value;
        return { servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } };
      });
      return {
        done,
        model: "deterministic-provider",
        recordSystemMessage: async (notice) => {
          notifications.push(notice.content);
          if (!notice.mutationEvidence) throw new Error("expected notice evidence");
          const page = await readMutationEvidenceFiles(notice.mutationEvidence, 0, 128, read);
          if (page.kind !== "available" || page.nextOffset !== null) throw new Error("expected complete notice files");
          for (const entry of page.files) {
            const action = entry.kind === "display" || entry.kind === "applied" ? entry.file.action : entry.kind === "omitted" ? entry.action : undefined;
            if (!action) throw new Error("expected review action");
            actions.push(action);
          }
        },
        notifyRecommendation: (recommendation) => { recommendations.push(recommendation.name); },
      };
    },
  });
  review.noteAssistantMessage("candidate turn");
  review.onTurnCompleted();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await review.settled();
  await done;
  return { projectRoot, userDataRoot, facts, actions, recommendations, notifications, childRuns, result };
}

function expectNoMutation(result: ScenarioResult, name: string): void {
  const dirs = ownedSkillStoreDirs({ projectRoot: result.projectRoot, userDataRoot: result.userDataRoot });
  expect(result.result.outcome).toBe("error");
  expect(existsSync(join(dirs.project, name))).toBe(false);
  expect(existsSync(join(dirs.project, ".operations", "audit"))).toBe(false);
  expect(result.facts).not.toContain("skill.written");
  expect(result.actions).toEqual([]);
  expect(result.recommendations).toEqual([]);
  expect(result.notifications).toEqual([]);
}

function archivedSkill(projectRoot: string, name: string): string {
  const dir = join(projectRoot, ".flywheel", "skills", ".archive", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE), `---\ndescription: ${JSON.stringify(`Use for ${name} work.`)}\nmanaged: flywheel\n---\nArchived procedure.\n`);
  return dir;
}

describe("Learning Review semantic admission through the production entrypoint", () => {
  it("publishes independent candidates and rejects supplied conflict or uncertain verdicts", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    const independent = await runScenario("independent-method", { output: '{"outcome":"independent"}' });
    expect(independent.result.outcome).toBe("ok");
    expect(independent.facts.filter((type) => type === "skill.written")).toHaveLength(1);

    expectNoMutation(await runScenario("supplied-conflict", { output: '{"outcome":"conflict"}' }), "supplied-conflict");
    expectNoMutation(await runScenario("supplied-uncertain", { output: '{"outcome":"uncertain"}' }), "supplied-uncertain");
  });

  it("publishes a valid project specialization once and composes canonical bundled context first", async () => {
    const name = "implementation-local";
    const result = await runScenario(name, {
      output: '{"outcome":"specialization","canonicalSkillId":"implementation"}',
      dependencies: ["implementation"],
    });
    expect(result.result.outcome).toBe("ok");
    expect(result.facts.filter((type) => type === "skill.written")).toHaveLength(1);
    const candidateBytes = readFileSync(join(result.projectRoot, ".flywheel", "skills", name, SKILL_FILE), "utf8");
    const revision = loadRegistry(result.projectRoot, result.userDataRoot, 2);
    const canonicalBody = revision.skills.get("implementation")?.body;
    expect(canonicalBody).toBeString();
    expect(candidateBytes).toContain("dependencies:\n  - implementation");
    expect(candidateBytes).not.toContain(canonicalBody ?? "missing canonical");
    const composed = renderSkillClosure([name], revision, "acceptance").join("\n");
    expect(composed.indexOf(canonicalBody ?? "missing canonical")).toBeLessThan(composed.indexOf("Project-specific delta."));
  });

  it("refuses an audit request over the model limit before child creation", async () => {
    const name = "oversized-audit";
    const result = await runScenario(name, { output: '{"outcome":"independent"}', contextLimit: 1_024 });
    expect(result.childRuns).toBe(0);
    expectNoMutation(result, name);
  });

  it("requires verified audit evidence for review restore while retaining interactive restore", async () => {
    const refusedName = "review-restore-refused";
    const refused = await runScenario(refusedName, { action: "restore", output: '{"outcome":"uncertain"}', setup: (root) => { archivedSkill(root, refusedName); } });
    expect(refused.result.outcome).toBe("error");
    expect(existsSync(join(refused.projectRoot, ".flywheel", "skills", ".archive", refusedName))).toBe(true);
    expect(refused.facts).not.toContain("skill.written");
    expect(refused.actions).toEqual([]);
    expect(refused.recommendations).toEqual([]);
    expect(refused.notifications).toEqual([]);

    const verifiedName = "review-restore-verified";
    const verified = await runScenario(verifiedName, { action: "restore", output: '{"outcome":"independent"}', setup: (root) => { archivedSkill(root, verifiedName); } });
    expect(verified.result.outcome).toBe("ok");
    expect(verified.facts.filter((type) => type === "skill.written")).toHaveLength(1);

    const interactiveName = "interactive-restore";
    const projectRoot = join(ROOT, interactiveName);
    const userDataRoot = join(ROOT, "home", ".flywheel");
    archivedSkill(projectRoot, interactiveName);
    const tool = createSkillManageTool({ origin: { kind: "user" }, registry: () => loadRegistry(projectRoot, userDataRoot), userDataRoot });
    let interactivePosition = 0;
    const interactiveWriter: SessionFactWriter = {
      stageSessionContentNodes: sessionContentFixture().stage,
      recordBatch: async () => null,
      record: async (fact) => ({ aggregateId: "session:interactive-restore", type: fact.type, version: fact.version, timestamp: Date.now(), actor: fact.actor, sessionId: "interactive-restore", payload: fact.payload, position: ++interactivePosition, id: `interactive-${interactivePosition}`, seq: interactivePosition }),
      recordGuarded: async (fact) => ({ kind: "stored", events: [{ aggregateId: "session:interactive-restore", type: fact.type, version: fact.version, timestamp: Date.now(), actor: fact.actor, sessionId: "interactive-restore", payload: fact.payload, position: ++interactivePosition, id: `interactive-${interactivePosition}`, seq: interactivePosition }] }),
      transaction: async (operation) => { operation(); },
      dispose: () => {},
    };
    const restored = await tool.execute({ action: "restore", name: interactiveName, reach: "project" }, makeContext({ projectRoot, executionCwd: projectRoot, sessionEventWriter: interactiveWriter }));
    expect(restored.outcome).toBe("ok");
    expect(existsSync(join(projectRoot, ".flywheel", "skills", interactiveName, SKILL_FILE))).toBe(true);
  });

  it("refuses stale candidate identity before journal and publication", async () => {
    const name = "stale-candidate";
    const result = await runScenario(name, {
      output: '{"outcome":"independent"}',
      afterAudit: (projectRoot) => {
        const destination = join(projectRoot, ".flywheel", "skills", name);
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, SKILL_FILE), "concurrent package");
      },
    });
    expect(result.result.content).toContain("appeared");
    expect(readFileSync(join(result.projectRoot, ".flywheel", "skills", name, SKILL_FILE), "utf8")).toBe("concurrent package");
    expect(result.facts).not.toContain("skill.written");
    expect(result.actions).toEqual([]);
    expect(result.recommendations).toEqual([]);
    expect(result.notifications).toEqual([]);
    expect(existsSync(join(result.projectRoot, ".flywheel", "skills", ".operations", "audit"))).toBe(false);
  });

  it("refuses specialization when an external same-id package shadows the bundled canonical", async () => {
    const name = "shadowed-specialization";
    const result = await runScenario(name, {
      output: '{"outcome":"specialization","canonicalSkillId":"implementation"}',
      dependencies: ["implementation"],
      setup: (projectRoot) => {
        const dir = join(projectRoot, ".flywheel", "skills", "implementation");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, SKILL_FILE), "---\ndescription: External implementation\n---\nExternal winner.\n");
      },
    });
    expectNoMutation(result, name);
    expect(loadRegistry(result.projectRoot, result.userDataRoot).bundledCorpus.has("implementation")).toBe(true);
    expect(loadRegistry(result.projectRoot, result.userDataRoot).skills.get("implementation")?.source.authority).toBe("external");
  });

  it("refuses a stale registry revision after audit and before locked publication", async () => {
    const name = "stale-revision";
    const result = await runScenario(name, {
      output: '{"outcome":"independent"}',
      afterAudit: (_projectRoot, setRegistry, pinned) => setRegistry(publishSkillRevision(pinned.revision + 1, pinned.skills, pinned.bundledCorpus)),
    });
    expect(result.result.content).toContain("stale");
    expectNoMutation(result, name);
  });
});
