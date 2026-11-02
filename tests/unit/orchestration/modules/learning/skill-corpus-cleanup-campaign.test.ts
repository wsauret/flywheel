import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { createSkillCorpusCleanupRequests, type SkillCorpusCleanupRequest } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-classifier.js";
import { runSkillCorpusCleanup } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup.js";
import { createSkillCorpusCleanupState } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-state.js";
import { eligibleLearnedSkill, eligibleLearnedSkills } from "../../../../../src/orchestration/modules/learning/learned-skill-eligibility.js";
import { withPackageLocks } from "../../../../../src/infra/package-directory-lock.js";
import type { SkillMutationPublication } from "../../../../../src/orchestration/modules/learning/skill-mutation-publisher.js";
import { publishSkillRevision, SKILL_FILE, type SkillRegistryRevision } from "../../../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions } from "../../../../../src/workflows/skills.js";

const TMP = join(tmpdir(), `flywheel-skill-corpus-cleanup-${randomUUID()}`);
const PROJECT_SKILLS = join(TMP, ".flywheel", "skills");
const BUNDLED_SKILLS = join(TMP, "bundled");
const MODULE_SKILLS = join(TMP, "module");
let store: ReturnType<typeof createSqliteEventStore>;
let now = 1_000;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(PROJECT_SKILLS, { recursive: true });
  store = createSqliteEventStore(join(TMP, "events.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(TMP, { recursive: true, force: true });
});

function install(root: string, id: string, dependencies: readonly string[] = [], managed = false): void {
  mkdirSync(join(root, id), { recursive: true });
  const dependencyLines = dependencies.length === 0 ? "" : `dependencies:\n${dependencies.map((dependency) => `  - ${dependency}`).join("\n")}\n`;
  writeFileSync(join(root, id, SKILL_FILE), `---\ndescription: Use for ${id} work.\n${managed ? "managed: flywheel\n" : ""}${dependencyLines}---\n${id} procedure.\n`);
}

function revision(): SkillRegistryRevision {
  const loaded = loadSkillDefinitions({ roots: [
    { authority: "external", dir: PROJECT_SKILLS, reach: "project" },
    { authority: "bundled", dir: BUNDLED_SKILLS, reach: "global", sourceKind: "agent" },
    { authority: "bundled", dir: MODULE_SKILLS, reach: "global", sourceKind: "module" },
  ] });
  return publishSkillRevision(1, loaded.skills, loaded.bundledCorpus);
}

function response(request: SkillCorpusCleanupRequest, outcome: (id: string, core: string) => "independent" | "specialization" | "conflict" | "uncertain"): string {
  return JSON.stringify({
    requestIdentity: request.requestIdentity,
    corePackageId: request.corePackageId,
    corePackageIdentity: request.corePackageIdentity,
    candidateShardIdentity: request.candidateShardIdentity,
    classifications: request.candidates.map((candidate) => {
      const result = outcome(candidate.id, request.corePackageId);
      return { candidateId: candidate.id, outcome: result, ...(result === "specialization" ? { canonicalSkillId: request.corePackageId } : {}) };
    }),
  });
}

async function completionAbsent(state: ReturnType<typeof createSkillCorpusCleanupState>): Promise<void> {
  const projection = await state.projection();
  expect(projection.completedCoreIdentity).toBeUndefined();
  expect(projection.completedManifest).toBeUndefined();
}

function campaign(
  outcome: (id: string, core: string) => "independent" | "specialization" | "conflict" | "uncertain",
  mutate?: () => void,
  transform?: (request: SkillCorpusCleanupRequest) => SkillCorpusCleanupRequest,
  publish?: NonNullable<Parameters<typeof runSkillCorpusCleanup>[0]["publish"]>,
) {
  const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now });
  return runSkillCorpusCleanup({
    config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision },
    state,
    classify: async (captured, coreIds, candidates) => {
      const requests = coreIds.flatMap((id) => createSkillCorpusCleanupRequests(captured, id, candidates, { contextLimit: 200_000, framingReserveTokens: 256, safetyReserveTokens: 2_048, outputReserveTokens: 4_096, estimateTokens: (text) => Math.ceil(text.length / 4) }));
      mutate?.();
      return requests.map((request) => { const returned = transform?.(request) ?? request; return { request: returned, output: response(returned, outcome) }; });
    },
    publish,
    record: async (fact) => store.append({ aggregateId: "audit", ...fact, timestamp: now, sessionId: "test" }),
  });
}

describe("skill corpus cleanup campaign", () => {
  it("completes an empty candidate set without claiming a core audit or calling the classifier", async () => {
    install(BUNDLED_SKILLS, "core");
    const result = await campaign(() => { throw new Error("no classification is needed"); });
    expect(result).toEqual({ kind: "completed", corePackages: 0, candidates: 0, archived: [] });
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "next", now: () => now });
    expect((await state.projection()).completedCoreIdentity).toEqual(revision().coreIdentity);
  });

  it("archives five conflicts from one core", async () => {
    install(BUNDLED_SKILLS, "core");
    for (let index = 0; index < 5; index += 1) install(PROJECT_SKILLS, `candidate-${index}`, [], true);
    const result = await campaign(() => "conflict");
    expect(result).toEqual({ kind: "completed", corePackages: 1, candidates: 5, archived: ["candidate-0", "candidate-1", "candidate-2", "candidate-3", "candidate-4"] });
    for (let index = 0; index < 5; index += 1) expect(existsSync(join(PROJECT_SKILLS, `candidate-${index}`))).toBe(false);
  });

  it("settles graceful cancellation without suppressing the next startup", async () => {
    install(BUNDLED_SKILLS, "core");
    install(PROJECT_SKILLS, "candidate", [], true);
    const controller = new AbortController();
    const firstState = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "first", now: () => now });
    const result = await runSkillCorpusCleanup({
      config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision },
      state: firstState,
      signal: controller.signal,
      classify: async (_captured, _coreIds, _candidates, signal) => {
        controller.abort(new DOMException("runtime shutdown", "AbortError"));
        signal.throwIfAborted();
        return [];
      },
      record: async () => null,
    });
    const current = revision();
    const retry = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "retry", now: () => now });

    expect(result.kind).toBe("campaign-deferred");
    expect((await retry.claim(current.coreIdentity, current.coreManifest)).kind).toBe("claimed");
  });

  it("deduplicates one conflict across cores and retains valid terminal outcomes", async () => {
    install(BUNDLED_SKILLS, "core-a");
    install(BUNDLED_SKILLS, "core-b");
    install(PROJECT_SKILLS, "conflict", [], true);
    install(PROJECT_SKILLS, "specialized", ["core-a"], true);
    install(PROJECT_SKILLS, "independent", [], true);
    install(PROJECT_SKILLS, "uncertain", [], true);
    const result = await campaign((id, core) => id === "conflict" ? "conflict" : id === "specialized" && core === "core-a" ? "specialization" : id === "uncertain" ? "uncertain" : "independent");
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") expect(result.archived).toEqual(["conflict"]);
    for (const id of ["specialized", "independent", "uncertain"]) expect(existsSync(join(PROJECT_SKILLS, id))).toBe(true);
  });

  it("archives an invalid specialization when captured evidence stays live", async () => {
    install(BUNDLED_SKILLS, "core");
    install(PROJECT_SKILLS, "invalid", [], true);
    const result = await campaign(() => "specialization");
    expect(result).toEqual({ kind: "completed", corePackages: 1, candidates: 1, archived: ["invalid"] });
    expect(existsSync(join(PROJECT_SKILLS, "invalid"))).toBe(false);
  });

  it("archives a specialization whose core id resolves to an external shadow", async () => {
    install(BUNDLED_SKILLS, "core");
    install(PROJECT_SKILLS, "core");
    install(PROJECT_SKILLS, "specialized", ["core"], true);

    const result = await campaign((id) => id === "specialized" ? "specialization" : "independent");

    expect(result).toEqual({ kind: "completed", corePackages: 1, candidates: 1, archived: ["specialized"] });
    expect(existsSync(join(PROJECT_SKILLS, "specialized"))).toBe(false);
    expect(existsSync(join(PROJECT_SKILLS, "core"))).toBe(true);
  });

  it("rejects a forged coordinator request before mutation", async () => {
    install(BUNDLED_SKILLS, "core");
    install(PROJECT_SKILLS, "candidate", [], true);
    const result = await campaign(() => "conflict", undefined, (request) => ({ ...request, requestIdentity: { ...request.requestIdentity, sha256: "f".repeat(64) } }));
    expect(result.kind).toBe("campaign-deferred");
    expect(existsSync(join(PROJECT_SKILLS, "candidate"))).toBe(true);
  });

  it("archives an invalid specialization and aborts all mutation on membership drift", async () => {
    install(BUNDLED_SKILLS, "core");
    install(PROJECT_SKILLS, "invalid", [], true);
    const drifted = await campaign(() => "specialization", () => install(PROJECT_SKILLS, "late", [], true));
    expect(drifted.kind).toBe("campaign-deferred");
    expect(existsSync(join(PROJECT_SKILLS, "invalid"))).toBe(true);
    expect(existsSync(join(PROJECT_SKILLS, "late"))).toBe(true);
  });

  it("settles no-candidate and removed-only campaigns without classification only while final state is unchanged", async () => {
    install(BUNDLED_SKILLS, "core");
    let classifyCalls = 0;
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now });
    const input = {
      config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision },
      state,
      classify: async () => { classifyCalls += 1; return []; },
      record: async () => null,
    };
    expect((await runSkillCorpusCleanup(input)).kind).toBe("completed");
    rmSync(join(BUNDLED_SKILLS, "core"), { recursive: true });
    now += 1;
    expect((await runSkillCorpusCleanup(input)).kind).toBe("completed");
    expect(classifyCalls).toBe(0);
  });

  it("withholds no-work completion when the final candidate set drifts", async () => {
    install(BUNDLED_SKILLS, "core");
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now });
    let scans = 0;
    const result = await runSkillCorpusCleanup({
      config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision }, state,
      classify: async () => { throw new Error("classification is forbidden"); }, record: async () => null,
      eligibleAll: (input) => {
        if (++scans !== 2) return eligibleLearnedSkills(input);
        install(PROJECT_SKILLS, "late", [], true);
        return eligibleLearnedSkills({ ...input, revision: revision() });
      },
    });
    expect(result.kind).toBe("campaign-deferred");
    await completionAbsent(state);
  });

  it("ignores module-only bundled identity changes after core completion", async () => {
    install(BUNDLED_SKILLS, "core");
    install(MODULE_SKILLS, "module-only");
    let classifyCalls = 0;
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now });
    const input = { config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision }, state, classify: async () => { classifyCalls += 1; return []; }, record: async () => null };
    expect((await runSkillCorpusCleanup(input)).kind).toBe("completed");
    install(MODULE_SKILLS, "module-only");
    writeFileSync(join(MODULE_SKILLS, "module-only", SKILL_FILE), "---\ndescription: Changed module package.\n---\nChanged module procedure.\n");
    expect(await runSkillCorpusCleanup(input)).toEqual({ kind: "already-complete" });
    expect(classifyCalls).toBe(0);
  });

  it.each([
    ["undefined", undefined],
    ["malformed", "not-json"],
  ] as const)("does not archive or complete for %s child output", async (_label, malformed) => {
    install(BUNDLED_SKILLS, "core"); install(PROJECT_SKILLS, "candidate", [], true);
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now });
    const result = await runSkillCorpusCleanup({ config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision }, state,
      classify: async (captured, coreIds, candidates) => coreIds.flatMap((id) => createSkillCorpusCleanupRequests(captured, id, candidates, { contextLimit: 200_000, framingReserveTokens: 256, safetyReserveTokens: 2_048, outputReserveTokens: 4_096, estimateTokens: (text) => Math.ceil(text.length / 4) })).map((request) => ({ request, output: malformed })), record: async () => null });
    expect(result.kind).toBe("campaign-deferred"); expect(existsSync(join(PROJECT_SKILLS, "candidate"))).toBe(true); await completionAbsent(state);
  });

  it.each(["identity", "membership"] as const)("withholds archive and completion for fresh %s drift before mutation", async (drift) => {
    install(BUNDLED_SKILLS, "core"); install(PROJECT_SKILLS, "candidate", [], true);
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now });
    const result = await runSkillCorpusCleanup({ config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision }, state,
      classify: async (captured, coreIds, candidates) => {
        const requests = coreIds.flatMap((id) => createSkillCorpusCleanupRequests(captured, id, candidates, { contextLimit: 200_000, framingReserveTokens: 256, safetyReserveTokens: 2_048, outputReserveTokens: 4_096, estimateTokens: (text) => Math.ceil(text.length / 4) }));
        if (drift === "identity") writeFileSync(join(PROJECT_SKILLS, "candidate", SKILL_FILE), "---\ndescription: Changed candidate.\nmanaged: flywheel\n---\nChanged.\n");
        if (drift === "membership") install(PROJECT_SKILLS, "late", [], true);
        return requests.map((request) => ({ request, output: response(request, () => "conflict") }));
      }, record: async () => null });
    expect(result.kind).toBe("campaign-deferred"); expect(existsSync(join(PROJECT_SKILLS, "candidate"))).toBe(true); await completionAbsent(state);
  });

  it.each(["refused", "published_unsettled"] as const)("withholds completion when archive publication is %s", async (kind) => {
    install(BUNDLED_SKILLS, "core"); install(PROJECT_SKILLS, "candidate", [], true);
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now });
    const publication: SkillMutationPublication = kind === "refused"
      ? { kind, error: "injected refusal" }
      : { kind, result: { kind: "written", action: "archived", name: "candidate", reach: "project", proposalId: "proposal", contentHash: "hash", diff: { version: 1, files: [], omissions: [] }, packageIdentity: { sha256: "a".repeat(64), bytes: 1 }, description: "candidate", message: "archived" }, pending: { path: "pending", fact: { type: "skill.written", version: 2, actor: "flywheel", payload: { name: "candidate", action: "archived", reach: "project", origin: { kind: "pruner" }, identity: { kind: "recorded", writeId: "write", proposalId: "proposal", packageIdentity: { sha256: "a".repeat(64), bytes: 1 } }, contentHash: "hash", description: "candidate" } } } };
    const result = await campaign(() => "conflict", undefined, undefined, async () => publication);
    expect(result.kind).toBe("campaign-deferred"); await completionAbsent(state);
  });

  it("withholds completion when retained candidates drift after a settled archive", async () => {
    install(BUNDLED_SKILLS, "core"); install(PROJECT_SKILLS, "archive", [], true); install(PROJECT_SKILLS, "retain", [], true);
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now });
    const result = await campaign((id) => id === "archive" ? "conflict" : "independent", undefined, undefined, async (input) => {
      const { publishSkillMutation } = await import("../../../../../src/orchestration/modules/learning/skill-mutation-publisher.js");
      const settled = await publishSkillMutation(input);
      if (settled.kind === "settled") writeFileSync(join(PROJECT_SKILLS, "retain", SKILL_FILE), "---\ndescription: Retained drift.\nmanaged: flywheel\n---\nChanged.\n");
      return settled;
    });
    expect(result.kind).toBe("campaign-deferred"); expect(existsSync(join(PROJECT_SKILLS, "archive"))).toBe(false); await completionAbsent(state);
  });

  it("enumerates eligibility only at campaign fences and guards each archive once", async () => {
    install(BUNDLED_SKILLS, "core"); for (const id of ["a", "b", "c"]) install(PROJECT_SKILLS, id, [], true);
    let all = 0; let one = 0;
    const result = await runSkillCorpusCleanup({
      config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision }, state: createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner", now: () => now }),
      classify: async (captured, coreIds, candidates) => coreIds.flatMap((id) => createSkillCorpusCleanupRequests(captured, id, candidates, { contextLimit: 200_000, framingReserveTokens: 256, safetyReserveTokens: 2_048, outputReserveTokens: 4_096, estimateTokens: (text) => Math.ceil(text.length / 4) })).map((request) => ({ request, output: response(request, () => "conflict") })),
      eligibleAll: (input) => { all += 1; return eligibleLearnedSkills(input); }, eligibleOne: (input, id) => { one += 1; return eligibleLearnedSkill(input, id); }, record: async (fact) => store.append({ aggregateId: "audit", ...fact, timestamp: now, sessionId: "test" }),
    });
    expect(result.kind).toBe("completed"); expect(all).toBe(3); expect(one).toBe(3);
  });

  it("does not hold the event store or package lock during classification", async () => {
    install(BUNDLED_SKILLS, "core"); install(PROJECT_SKILLS, "candidate", [], true);
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let entered!: () => void; const pending = new Promise<void>((resolve) => { entered = resolve; });
    const state = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId: "owner-a", now: () => now });
    const run = runSkillCorpusCleanup({ config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: revision }, state, classify: async () => { entered(); await held; return []; }, record: async () => null });
    await pending;
    const secondStore = createSqliteEventStore(join(TMP, "events.sqlite"));
    const second = createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(secondStore), writer: secondStore, ownerId: "owner-b", now: () => now });
    const appended = secondStore.append({ aggregateId: "other", type: "test.fact", version: 1, actor: "system", payload: {}, timestamp: now, sessionId: "test" });
    const claim = await second.claim(revision().coreIdentity, revision().coreManifest);
    let packageLockAcquired = false; await withPackageLocks([join(PROJECT_SKILLS, "candidate")], async () => { packageLockAcquired = true; });
    expect(appended.seq).toBe(0); expect(claim.kind).toBe("leased"); expect(packageLockAcquired).toBe(true);
    secondStore.close(); release(); await run;
  });
});