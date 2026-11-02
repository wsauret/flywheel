import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore, type StoredFact } from "../../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { createSkillManageTool } from "../../../../../src/orchestration/modules/learning/tools/skill-manage.js";
import type { ToolContext, ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { ConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree.js";
import { createConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js";
import { loadAgentInputProjection } from "../../../../../src/orchestration/session/agent-input-projection.js";
import { createSessionFactWriter, type SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { reconcileLearning } from "../../../../../src/orchestration/modules/learning/reconciliation.js";
import type { SkillWriteOrigin } from "../../../../../src/orchestration/modules/learning/skill-store-types.js";
import { publishSkillRevision, SKILL_FILE } from "../../../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../../../src/workflows/skills.js";
import { operationIdentity, readOperationManifest } from "../../../../../src/orchestration/modules/learning/skill-operation-manifest.js";
import { makeContext } from "../../agent-runtime/tools/_fixtures.js";

const TMP = join(tmpdir(), `flywheel-skill-recommendation-${randomUUID()}`);
const CWD = join(TMP, "project");
const HOME = join(TMP, "home");
const SESSION = "sess-recommend";

const AGENT: SkillWriteOrigin = { kind: "agent", sessionId: SESSION };

let store: LocalSqliteEventStore;
let writer: SessionFactWriter;
let conversation: ConversationTree;

function reviewOrigin(loaded: readonly string[] = []): SkillWriteOrigin {
  return { kind: "review", reviewRunId: "rev-1", loadedSkillIds: new Set(loaded) };
}

function registry() {
  const dirs = ownedSkillStoreDirs({ projectRoot: CWD, userDataRoot: HOME });
  const load = loadSkillDefinitions({
    roots: [
      { authority: "external", dir: dirs.project, reach: "project" },
      { authority: "external", dir: dirs.user, reach: "global" },
    ],
  });
  return publishSkillRevision(1, load.skills);
}

function globalRoot(): string {
  return ownedSkillStoreDirs({ projectRoot: CWD, userDataRoot: HOME }).user;
}

function projectRoot(): string {
  return ownedSkillStoreDirs({ projectRoot: CWD, userDataRoot: HOME }).project;
}

function skillManage(origin: SkillWriteOrigin = AGENT) {
  return createSkillManageTool({
    origin,
    registry,
    userDataRoot: HOME,
    store: asAsyncEventReadSurface(store),
    sessionId: SESSION,
    onCandidate: (candidate, revision) => Promise.resolve({
      kind: "verified",
      evidence: {
        candidateIdentity: candidate.identity,
        registryRevision: revision.revision,
        outcome: { outcome: "independent" },
      },
    }),
  });
}

function context(toolUseId: string): ToolContext {
  return makeContext({ executionCwd: CWD, projectRoot: CWD, toolUseId, sessionId: SESSION, conversationId: "conv-1", sessionEventWriter: writer });
}

function identityIn(result: ToolResult, label: string): string {
  const match = new RegExp(`${label}: ?"?([0-9a-f]{64})`).exec(String(result.content));
  if (!match?.[1]) throw new Error(`no ${label} in: ${String(result.content)}`);
  return match[1];
}

function recommendationFacts(): StoredFact[] {
  return store.read({ aggregateId: `session:${SESSION}`, types: ["skill.recommendation.recorded"] });
}

/** The review's own project candidate, created the way the review creates one. */
async function createCandidate(name = "deploy-runbook"): Promise<void> {
  const created = await skillManage(reviewOrigin()).execute({
    action: "save",
    name,
    description: `Use when the task is a ${name}.`,
    body: "Step 1. Verify. Step 2. Ship.",
    reach: "project",
  }, context("call-create"));
  expect(created.outcome).toBe("ok");
}

async function recommend(name = "deploy-runbook"): Promise<ToolResult> {
  return skillManage(reviewOrigin([name])).execute({ action: "recommend", name }, context("call-recommend"));
}

/** Deliver every recorded recommendation the conversation does not hold. */
async function deliver(): Promise<readonly string[]> {
  return (await reconcileLearning({
    projectRoot: CWD,
    sessionId: SESSION,
    conversationId: "conv-1",
    store: asAsyncEventReadSurface(store),
    auditStores: [],
    appendSystemTurn: async (content) => {
      await conversation.appendMessage({ kind: "user", content, origin: "system" });
    },
  })).delivered;
}

beforeEach(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  store = createSqliteEventStore(join(TMP, "flywheel.sqlite"));
  writer = createSessionFactWriter({ sessionId: SESSION, writer: asAsyncEventWriter(store) });
  conversation = await createConversationTree({
    sessionId: SESSION, conversationId: "conv-1", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
  });
});

afterEach(() => {
  writer.dispose();
  store.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("a background review recommends instead of writing globally", () => {
  it("records the prepared promotion identity and leaves the global store untouched", async () => {
    await createCandidate();

    const result = await recommend();

    expect(result.outcome).toBe("ok");
    const recommendationId = identityIn(result, "recommendation");
    expect(existsSync(join(globalRoot(), "deploy-runbook"))).toBe(false);
    // Not even the operation area: a recommendation prepares nothing durable
    // in the store it recommends writing to.
    expect(existsSync(join(globalRoot(), ".operations"))).toBe(false);

    const facts = recommendationFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.payload).toMatchObject({
      recommendationId,
      name: "deploy-runbook",
      action: "promote",
      reach: "global",
      origin: { kind: "review", reviewRunId: "rev-1" },
    });
  });

  it("refuses a recommendation from an interactive origin, which can ask instead", async () => {
    await createCandidate();

    const result = await skillManage().execute({ action: "recommend", name: "deploy-runbook" }, context("call-recommend"));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("promote");
    expect(recommendationFacts()).toHaveLength(0);
  });

  it("refuses to recommend a promotion the global store already conflicts with", async () => {
    mkdirSync(join(globalRoot(), "deploy-runbook"), { recursive: true });
    writeFileSync(join(globalRoot(), "deploy-runbook", SKILL_FILE), "---\ndescription: Use for global runbook work.\nmanaged: flywheel\n---\nGlobal body.\n");
    mkdirSync(join(projectRoot(), "deploy-runbook"), { recursive: true });
    writeFileSync(join(projectRoot(), "deploy-runbook", SKILL_FILE), "---\ndescription: Use for project runbook work.\nmanaged: flywheel\n---\nProject body.\n");

    const result = await recommend();

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("shadows another installed package");
    expect(result.content).toContain("distinct id");
    expect(recommendationFacts()).toHaveLength(0);
  });
});

describe("recommendation delivery is keyed by its identity", () => {
  it("enters the parent conversation exactly once across repeated passes", async () => {
    await createCandidate();
    const recommendationId = identityIn(await recommend(), "recommendation");

    const first = await deliver();
    const second = await deliver();

    expect(first).toEqual([recommendationId]);
    expect(second).toEqual([]);
    const delivered = (await conversation.buildContext()).messages.filter((message) => message.kind === "user" && typeof message.content === "string" && message.content.includes(recommendationId));
    expect(delivered).toHaveLength(1);
    expect(String(delivered[0]?.content)).toContain("deploy-runbook");
  });

  it("redelivers after a crash between the fact and the append", async () => {
    await createCandidate();
    const recommendationId = identityIn(await recommend(), "recommendation");

    // The fact is durable, the append never happened: a reconstructed session
    // reads the recommendation from the store and delivers it.
    expect(await deliver()).toEqual([recommendationId]);
    expect(await deliver()).toEqual([]);
  });
});

describe("the interactive turn applies the recommendation", () => {
  it("promotes the recommended package without another approval", async () => {
    await createCandidate();
    const recommendationId = identityIn(await recommend(), "recommendation");
    await deliver();
    const commit = await skillManage().execute({ action: "promote", name: "deploy-runbook" }, context("call-promote"));
    expect(commit.outcome).toBe("ok");
    const operation = readOperationManifest(globalRoot(), operationIdentity({ sessionId: SESSION, interactionId: "call-promote" }, recommendationId));
    expect(operation.kind).toBe("ok");
    expect((await loadAgentInputProjection(asAsyncEventReadSurface(store), SESSION)).size).toBe(0);
    expect(readFileSync(join(globalRoot(), "deploy-runbook", SKILL_FILE), "utf8")).toContain("Step 1. Verify.");
    expect(existsSync(join(projectRoot(), "deploy-runbook"))).toBe(false);
  });
});

describe("an unapplied recommendation changes nothing", () => {
  it("keeps the project package installed and the global store empty", async () => {
    await createCandidate();
    await recommend();
    await deliver();
    expect(readFileSync(join(projectRoot(), "deploy-runbook", SKILL_FILE), "utf8")).toContain("Step 1. Verify.");
    expect(existsSync(join(globalRoot(), "deploy-runbook"))).toBe(false);
  });
});

describe("a distinct specialization uses a distinct id", () => {
  it("installs beside the promoted global package and may reference it", async () => {
    await createCandidate();
    await recommend();
    const promoted = await skillManage().execute({ action: "promote", name: "deploy-runbook" }, context("call-commit"));
    expect(promoted.outcome).toBe("ok");

    const specialization = await skillManage().execute({
      action: "save",
      name: "deploy-runbook-here",
      description: "Use when deploying this repository specifically.",
      body: "Follow the deploy-runbook skill, then run the repository smoke test.",
      reach: "project",
    }, context("call-specialize"));

    expect(specialization.outcome).toBe("ok");
    const skills = registry().skills;
    expect(skills.get("deploy-runbook")?.source.reach).toBe("global");
    expect(skills.get("deploy-runbook-here")?.source.reach).toBe("project");
  });
});
