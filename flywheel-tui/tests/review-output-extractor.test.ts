import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  REVIEW_MULTI_AGENT_STEP_INDEX,
  REVIEW_CONSOLIDATION_STEP_INDEX,
  REVIEW_P3_DIRECTIVE,
  createReviewOnStepComplete,
  type P3Finding,
  type FindingCounts,
} from "../src/workflows/review-output-extractor";
import type { WorkerResult } from "../src/schemas/worker";
import { QuestionService } from "../src/controller/question-service";
import { EventBus } from "../src/events/event-bus";

// ---------------------------------------------------------------------------
// Local type helpers for triage assertions
// ---------------------------------------------------------------------------

interface P3TriageExplicit {
  included: P3Finding[];
  excluded: P3Finding[];
  source: string;
}

interface P3TriageDirective {
  directive: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), `flywheel-review-extract-${process.pid}-${Date.now()}`);

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

/** Helper to create a WorkerResult with the given output and optional handoff path. */
function workerResult(output: string, handoffPath = ""): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
    handoffPath,
  };
}

/** A summary string that satisfies the 100-char minimum. */
const VALID_SUMMARY = "Multi-agent review is complete. All findings have been categorized by severity. The review covered architecture, correctness, security, and performance across all modified files.";

/** Write a handoff JSON file with p3_findings and return its path. */
function writeHandoffWithP3(dir: string, findings: object[]): string {
  const handoffPath = path.join(dir, "handoff.json");
  const handoff: Record<string, unknown> = {
    summary: VALID_SUMMARY,
  };
  if (findings.length > 0) {
    handoff.p3_findings = findings;
  }
  fs.writeFileSync(handoffPath, JSON.stringify(handoff));
  return handoffPath;
}

/** Write a handoff JSON file with consolidation data and return its path. */
function writeHandoffWithConsolidation(
  dir: string,
  reviewFilePath?: string,
  findingCounts?: { p1_critical: number; p2_important: number; p3_suggestion: number },
): string {
  const handoffPath = path.join(dir, "handoff.json");
  const handoff: Record<string, unknown> = {
    summary: VALID_SUMMARY,
  };
  if (reviewFilePath) handoff.review_file_path = reviewFilePath;
  if (findingCounts) handoff.finding_counts = findingCounts;
  fs.writeFileSync(handoffPath, JSON.stringify(handoff));
  return handoffPath;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("review-output-extractor constants", () => {
  it("REVIEW_MULTI_AGENT_STEP_INDEX is 0", () => {
    expect(REVIEW_MULTI_AGENT_STEP_INDEX).toBe(0);
  });

  it("REVIEW_P3_DIRECTIVE is 'include-non-cosmetic'", () => {
    expect(REVIEW_P3_DIRECTIVE).toBe("include-non-cosmetic");
  });

  it("REVIEW_CONSOLIDATION_STEP_INDEX is 1", () => {
    expect(REVIEW_CONSOLIDATION_STEP_INDEX).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createReviewOnStepComplete — P3 triage (handoff-based)
// ---------------------------------------------------------------------------

describe("createReviewOnStepComplete — P3 triage (handoff-based)", () => {
  it("interactive: true + user picks items → p3Triage with included/excluded/source", async () => {
    const dir = ensureTmpDir();
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    const handoffPath = writeHandoffWithP3(dir, [
      { description: "Naming convention", location: "src/b.ts:5", suggestion: "Use camelCase" },
      { description: "Dead code", location: "src/c.ts:10", suggestion: "Remove unused function" },
    ]);

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: true,
    });

    bus.subscribeToType("question:asked", (e) => {
      qs.reply(e.requestId, [["Naming convention"]]);
    });

    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult("", handoffPath),
      {},
    );

    expect(result.p3Triage).toBeDefined();
    const triage = result.p3Triage as P3TriageExplicit;
    expect(triage.source).toBe("user");
    expect(triage.included).toHaveLength(1);
    expect(triage.included[0].title).toBe("Naming convention");
    expect(triage.excluded).toHaveLength(1);
    expect(triage.excluded[0].title).toBe("Dead code");
  });

  it("interactive: true + user dismisses → p3Triage with directive", async () => {
    const dir = ensureTmpDir();
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    const handoffPath = writeHandoffWithP3(dir, [
      { description: "Naming convention", location: "src/b.ts:5", suggestion: "Use camelCase" },
    ]);

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: true,
    });

    bus.subscribeToType("question:asked", (e) => {
      qs.reject(e.requestId);
    });

    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult("", handoffPath),
      {},
    );

    expect(result.p3Triage).toBeDefined();
    const triage = result.p3Triage as P3TriageDirective;
    expect(triage.directive).toBe(REVIEW_P3_DIRECTIVE);
  });

  it("interactive: false → p3Triage with directive (never calls ask)", async () => {
    const dir = ensureTmpDir();
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    let askCalled = false;
    bus.subscribe((event) => {
      if (event.type === "question:asked") askCalled = true;
    });

    const handoffPath = writeHandoffWithP3(dir, [
      { description: "Naming convention", location: "src/b.ts:5", suggestion: "Use camelCase" },
    ]);

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: false,
    });

    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult("", handoffPath),
      {},
    );

    expect(askCalled).toBe(false);
    expect(result.p3Triage).toBeDefined();
    const triage = result.p3Triage as { directive: string };
    expect(triage.directive).toBe(REVIEW_P3_DIRECTIVE);
  });

  it("no handoff → empty object (no P3 triage)", async () => {
    const hook = createReviewOnStepComplete({ interactive: true });
    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult("output with P3 findings in stdout"),
      {},
    );
    expect(result).toEqual({});
  });

  it("handoff with no p3_findings → empty object", async () => {
    const dir = ensureTmpDir();
    const handoffPath = writeHandoffWithP3(dir, []);
    const hook = createReviewOnStepComplete({ interactive: true });
    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult("", handoffPath),
      {},
    );
    expect(result).toEqual({});
  });

  it("unexpected error → logs, returns empty object", async () => {
    const dir = ensureTmpDir();
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    qs.ask = async () => {
      throw new Error("Unexpected network failure");
    };

    const handoffPath = writeHandoffWithP3(dir, [
      { description: "Issue", location: "src/a.ts:1", suggestion: "Fix it" },
    ]);

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: true,
    });

    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult("", handoffPath),
      {},
    );
    expect(result).toEqual({});
  });

  it("non-review step returns empty object", async () => {
    const hook = createReviewOnStepComplete({ interactive: false });
    const result = await hook(99, workerResult("Some output"), {});
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// createReviewOnStepComplete — consolidation step (handoff-based)
// ---------------------------------------------------------------------------

describe("createReviewOnStepComplete — consolidation step (handoff-based)", () => {
  it("handoff with review_file_path and finding_counts → returns all fields", async () => {
    const dir = ensureTmpDir();
    const handoffPath = writeHandoffWithConsolidation(
      dir,
      "docs/reviews/2026-03-23-auth-refactor.md",
      { p1_critical: 1, p2_important: 2, p3_suggestion: 3 },
    );

    const hook = createReviewOnStepComplete({ interactive: false });
    const result = await hook(
      REVIEW_CONSOLIDATION_STEP_INDEX,
      workerResult("", handoffPath),
      {},
    );

    expect(result.reviewFilePath).toBe("docs/reviews/2026-03-23-auth-refactor.md");
    expect(result.findingCounts).toEqual({ p1: 1, p2: 2, p3: 3 });
    expect(result.hasActionableFindings).toBe(true);
  });

  it("handoff with no actionable findings → hasActionableFindings: false", async () => {
    const dir = ensureTmpDir();
    const handoffPath = writeHandoffWithConsolidation(
      dir,
      "docs/reviews/2026-03-23-cleanup.md",
      { p1_critical: 0, p2_important: 0, p3_suggestion: 4 },
    );

    const hook = createReviewOnStepComplete({ interactive: false });
    const result = await hook(
      REVIEW_CONSOLIDATION_STEP_INDEX,
      workerResult("", handoffPath),
      {},
    );

    expect(result.reviewFilePath).toBe("docs/reviews/2026-03-23-cleanup.md");
    expect(result.findingCounts).toEqual({ p1: 0, p2: 0, p3: 4 });
    expect(result.hasActionableFindings).toBe(false);
  });

  it("no handoff → returns zeros", async () => {
    const hook = createReviewOnStepComplete({ interactive: false });
    const result = await hook(
      REVIEW_CONSOLIDATION_STEP_INDEX,
      workerResult("output with findings in stdout"),
      {},
    );

    expect(result.findingCounts).toEqual({ p1: 0, p2: 0, p3: 0 });
    expect(result.hasActionableFindings).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: full onStepComplete data flow (accumulated extra)
// ---------------------------------------------------------------------------

describe("createReviewOnStepComplete — full data flow integration", () => {
  it("step 1 → p3Triage, step 2 → reviewFilePath + findingCounts, accumulated together", async () => {
    const dir = ensureTmpDir();

    // Step 1 handoff: P3 findings
    const handoff1 = writeHandoffWithP3(dir, [
      { description: "Naming convention", location: "src/b.ts:5", suggestion: "Use camelCase" },
    ]);

    // Step 2 handoff: consolidation data
    const handoff2Dir = path.join(dir, "step2");
    fs.mkdirSync(handoff2Dir, { recursive: true });
    const handoff2 = writeHandoffWithConsolidation(
      handoff2Dir,
      "docs/reviews/2026-03-23-auth-refactor.md",
      { p1_critical: 1, p2_important: 2, p3_suggestion: 3 },
    );

    const hook = createReviewOnStepComplete({ interactive: false });
    const accumulatedExtra: Record<string, unknown> = {};

    // Step 1: multi-agent review
    const step1Result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult("", handoff1),
      { ...accumulatedExtra },
    );
    Object.assign(accumulatedExtra, step1Result);

    expect(accumulatedExtra.p3Triage).toBeDefined();
    const triage = accumulatedExtra.p3Triage as P3TriageDirective;
    expect(triage.directive).toBe(REVIEW_P3_DIRECTIVE);

    // Step 2: consolidation
    const step2Result = await hook(
      REVIEW_CONSOLIDATION_STEP_INDEX,
      workerResult("", handoff2),
      { ...accumulatedExtra },
    );
    Object.assign(accumulatedExtra, step2Result);

    expect(accumulatedExtra.p3Triage).toBeDefined();
    expect(accumulatedExtra.reviewFilePath).toBe("docs/reviews/2026-03-23-auth-refactor.md");
    expect(accumulatedExtra.findingCounts).toEqual({ p1: 1, p2: 2, p3: 3 });
    expect(accumulatedExtra.hasActionableFindings).toBe(true);
  });
});
