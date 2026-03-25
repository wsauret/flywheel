import { describe, it, expect } from "bun:test";
import type { WorkflowStepContext } from "../src/prompts/index";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseCtx: WorkflowStepContext = {
  planContent: "How does the event bus work in this codebase?",
  keyDecisions: [],
  fileReferences: ["src/events/event-bus.ts", "src/events/types.ts"],
  projectCwd: "/home/user/project",
};

const minimalCtx: WorkflowStepContext = {
  planContent: "Investigate caching patterns",
  keyDecisions: [],
  fileReferences: [],
};

const ctxWithPreviousResult: WorkflowStepContext = {
  planContent: "How does the event bus work?",
  keyDecisions: [],
  fileReferences: [],
  previousResult: "Locator output: found 15 files related to event bus...",
  projectCwd: "/home/user/project",
};

const ctxWithAnalysisResult: WorkflowStepContext = {
  planContent: "How does the event bus work?",
  keyDecisions: [],
  fileReferences: [],
  previousResult: "Analysis output: EventBus uses pub/sub pattern with 29 event types...",
  projectCwd: "/home/user/project",
};

// ---------------------------------------------------------------------------
// Orchestration leak phrases — must NEVER appear in any prompt output
// ---------------------------------------------------------------------------

const ORCHESTRATION_LEAKS = [
  "Phase 0:",
  "session.md",
  ".flywheel/session",
  "Ralph mode",
  "Ralph Mode",
  "question:",
  "carry on",
  "resume",
  "$ARGUMENTS",
];

function assertNoOrchestrationLeaks(output: string) {
  for (const phrase of ORCHESTRATION_LEAKS) {
    expect(output).not.toContain(phrase);
  }
}

// ---------------------------------------------------------------------------
// VAL-RP-001: Dedicated research prompt directory exists with per-step templates
// ---------------------------------------------------------------------------

describe("Research prompt directory and exports", () => {
  it("src/prompts/research/index.ts exports all 3 prompt builders", async () => {
    const mod = await import("../src/prompts/research/index");
    expect(typeof mod.buildResearchLocatePrompt).toBe("function");
    expect(typeof mod.buildResearchAnalyzePrompt).toBe("function");
    expect(typeof mod.buildResearchPersistPrompt).toBe("function");
  });

  it("each prompt builder accepts WorkflowStepContext and returns string", async () => {
    const { buildResearchLocatePrompt, buildResearchAnalyzePrompt, buildResearchPersistPrompt } =
      await import("../src/prompts/research/index");

    const locate = buildResearchLocatePrompt(baseCtx);
    const analyze = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    const persist = buildResearchPersistPrompt(ctxWithAnalysisResult);

    expect(typeof locate).toBe("string");
    expect(typeof analyze).toBe("string");
    expect(typeof persist).toBe("string");
    expect(locate.length).toBeGreaterThan(0);
    expect(analyze.length).toBeGreaterThan(0);
    expect(persist.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-RP-002: Locate prompt is step-specific
// ---------------------------------------------------------------------------

describe("buildResearchLocatePrompt", () => {
  it("has title '# Research: Locate Sources'", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("# Research: Locate Sources");
  });

  it("includes the user's research topic from ctx.planContent", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("How does the event bus work");
  });

  it("contains DOCUMENTARIAN_MODE convention", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("Documentarian Mode");
  });

  it("contains LOCATOR_ANALYZER_PATTERN convention", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("Locator → Analyzer Pattern");
  });

  it("contains FILE_LINE_DISCIPLINE convention", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("File/Line Citation");
  });

  it("contains READ_FULLY_RULE convention", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("Read Fully Rule");
  });

  it("contains locator dispatch templates", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("locator-codebase");
    expect(result).toContain("locator-patterns");
    expect(result).toContain("locator-docs");
  });

  it("contains the BLOCKING rule", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("BLOCKING");
    expect(result).toContain("Do NOT use Read/Grep/Glob for target codebase research directly");
  });

  it("instructs parallel dispatch of all 3 locators", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result.toLowerCase()).toContain("parallel");
  });

  it("contains ranking criteria for locator results", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("Direct relevance");
    expect(result).toContain("Modification targets");
    expect(result).toContain("Pattern exemplars");
    expect(result).toContain("Constraint docs");
  });

  it("sets locator output token limit to 500", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("500 token");
  });

  it("does NOT contain analyzer templates", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).not.toContain("analyzer-codebase");
    expect(result).not.toContain("analyzer-patterns");
  });

  it("does NOT contain persistence instructions", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).not.toContain("docs/research/");
    expect(result).not.toContain("YYYY-MM-DD");
  });

  it("handles minimal context without crashing", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("has no orchestration leaks", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    assertNoOrchestrationLeaks(buildResearchLocatePrompt(baseCtx));
    assertNoOrchestrationLeaks(buildResearchLocatePrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// VAL-RP-003: Analyze prompt is step-specific
// ---------------------------------------------------------------------------

describe("buildResearchAnalyzePrompt", () => {
  it("has title '# Research: Analyze Sources'", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("# Research: Analyze Sources");
  });

  it("references ctx.previousResult (locator output)", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("Locator output: found 15 files related to event bus...");
  });

  it("contains analyzer dispatch templates", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("analyzer-codebase");
    expect(result).toContain("analyzer-patterns");
  });

  it("instructs filtering with limits (max 15 files, 10 patterns, 5 docs)", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("15");
    expect(result).toContain("10");
    expect(result).toContain("5");
  });

  it("contains DOCUMENTARIAN_MODE convention", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("Documentarian Mode");
  });

  it("contains FILE_LINE_DISCIPLINE convention", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("File/Line Citation");
  });

  it("contains READ_FULLY_RULE convention", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("Read Fully Rule");
  });

  it("sets analyzer output token limit to 750", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("750 token");
  });

  it("does NOT contain locator templates", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).not.toContain("locator-codebase");
    expect(result).not.toContain("locator-patterns");
    expect(result).not.toContain("locator-docs");
  });

  it("does NOT contain persistence instructions", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).not.toContain("docs/research/");
    expect(result).not.toContain("YYYY-MM-DD");
  });

  it("handles minimal context without crashing", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("has no orchestration leaks", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    assertNoOrchestrationLeaks(buildResearchAnalyzePrompt(ctxWithPreviousResult));
    assertNoOrchestrationLeaks(buildResearchAnalyzePrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// VAL-RP-004: Persist prompt is step-specific
// ---------------------------------------------------------------------------

describe("buildResearchPersistPrompt", () => {
  it("has title '# Research: Compile Document'", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain("# Research: Compile Document");
  });

  it("references ctx.previousResult (analysis output)", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain("Analysis output: EventBus uses pub/sub pattern");
  });

  it("instructs writing to .flywheel/research/YYYY-MM-DD-<topic-slug>.md", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain(".flywheel/research/");
    expect(result).toContain("YYYY-MM-DD");
    expect(result).toContain("topic-slug");
  });

  it("includes full YAML frontmatter template", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain("date:");
    expect(result).toContain("topic:");
    expect(result).toContain("status: complete");
    expect(result).toContain("tags:");
    expect(result).toContain("research");
  });

  it("includes all required standalone sections", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain("Research Question");
    expect(result).toContain("Summary");
    expect(result).toContain("Detailed Findings");
    expect(result).toContain("Code References");
    expect(result).toContain("Patterns Identified");
    expect(result).toContain("Open Questions");
  });

  it("includes Code References table format", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain("File");
    expect(result).toContain("Lines");
    expect(result).toContain("Description");
  });

  it("contains DOCUMENTARIAN_MODE convention", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain("Documentarian Mode");
  });

  it("contains FILE_LINE_DISCIPLINE convention", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain("File/Line Citation");
  });

  it("does NOT contain locator templates", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).not.toContain("locator-codebase");
    expect(result).not.toContain("locator-patterns");
    expect(result).not.toContain("locator-docs");
  });

  it("does NOT contain analyzer templates", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).not.toContain("analyzer-codebase");
    expect(result).not.toContain("analyzer-patterns");
  });

  it("handles minimal context without crashing", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("has no orchestration leaks", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    assertNoOrchestrationLeaks(buildResearchPersistPrompt(ctxWithAnalysisResult));
    assertNoOrchestrationLeaks(buildResearchPersistPrompt(minimalCtx));
  });
});

// ---------------------------------------------------------------------------
// VAL-RP-005: Plan research prompt is differentiated from standalone
// ---------------------------------------------------------------------------

describe("Plan research prompt vs standalone research prompts", () => {
  it("plan research prompt mentions .context.md", async () => {
    const { buildPlanResearchPrompt } = await import("../src/prompts/plan/research");
    const result = buildPlanResearchPrompt(baseCtx);
    expect(result).toContain(".context.md");
  });

  it("standalone persist prompt mentions .flywheel/research/, not .context.md", async () => {
    const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
    const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
    expect(result).toContain(".flywheel/research/");
    expect(result).not.toContain(".context.md");
  });

  it("plan research prompt is a single combined locate+analyze step", async () => {
    const { buildPlanResearchPrompt } = await import("../src/prompts/plan/research");
    const result = buildPlanResearchPrompt(baseCtx);
    // Plan research has BOTH locator and analyzer templates (combined)
    expect(result).toContain("locator-codebase");
    expect(result).toContain("analyzer-codebase");
  });

  it("standalone locate prompt has locators but no analyzers", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("locator-codebase");
    expect(result).not.toContain("analyzer-codebase");
  });
});

// ---------------------------------------------------------------------------
// VAL-RP-006: Both variants share core conventions
// ---------------------------------------------------------------------------

describe("Shared core conventions across plan and standalone research prompts", () => {
  const conventions = [
    { name: "DOCUMENTARIAN_MODE", match: "Documentarian Mode" },
    { name: "LOCATOR_ANALYZER_PATTERN", match: "Locator → Analyzer Pattern" },
    { name: "FILE_LINE_DISCIPLINE", match: "File/Line Citation" },
    { name: "READ_FULLY_RULE", match: "Read Fully Rule" },
  ];

  for (const { name, match } of conventions) {
    it(`plan research prompt includes ${name}`, async () => {
      const { buildPlanResearchPrompt } = await import("../src/prompts/plan/research");
      const result = buildPlanResearchPrompt(baseCtx);
      expect(result).toContain(match);
    });

    it(`locate prompt includes ${name}`, async () => {
      const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
      const result = buildResearchLocatePrompt(baseCtx);
      expect(result).toContain(match);
    });
  }

  // Analyze and persist only need their specific conventions
  for (const { name, match } of conventions.filter(c =>
    c.name === "DOCUMENTARIAN_MODE" || c.name === "FILE_LINE_DISCIPLINE"
  )) {
    it(`analyze prompt includes ${name}`, async () => {
      const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
      const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
      expect(result).toContain(match);
    });

    it(`persist prompt includes ${name}`, async () => {
      const { buildResearchPersistPrompt } = await import("../src/prompts/research/index");
      const result = buildResearchPersistPrompt(ctxWithAnalysisResult);
      expect(result).toContain(match);
    });
  }
});

// ---------------------------------------------------------------------------
// VAL-RP-009: TOKEN_LIMITS relaxed for research output
// ---------------------------------------------------------------------------

describe("TOKEN_LIMITS relaxation", () => {
  it("TOKEN_LIMITS has research output limit > 500 tokens", async () => {
    const { TOKEN_LIMITS } = await import("../src/prompts/conventions");
    // Should NOT say "max 500 tokens" for research output
    // Should say something higher (e.g., 2000 or more)
    const researchLine = TOKEN_LIMITS.split("\n").find(l => l.toLowerCase().includes("research output"));
    expect(researchLine).toBeDefined();
    // Extract the number from the line
    const match = researchLine!.match(/(\d+)\s*tokens?/i);
    expect(match).toBeTruthy();
    const limit = parseInt(match![1], 10);
    expect(limit).toBeGreaterThan(500);
  });

  it("TOKEN_LIMITS keeps locator output at 500 tokens", async () => {
    const { TOKEN_LIMITS } = await import("../src/prompts/conventions");
    const locatorLine = TOKEN_LIMITS.split("\n").find(l => l.toLowerCase().includes("locator output"));
    expect(locatorLine).toBeDefined();
    expect(locatorLine).toContain("500");
  });

  it("TOKEN_LIMITS keeps analyzer output at 750 tokens", async () => {
    const { TOKEN_LIMITS } = await import("../src/prompts/conventions");
    const analyzerLine = TOKEN_LIMITS.split("\n").find(l => l.toLowerCase().includes("analyzer output"));
    expect(analyzerLine).toBeDefined();
    expect(analyzerLine).toContain("750");
  });

  it("TOKEN_LIMITS keeps reviewer output at 1000 tokens", async () => {
    const { TOKEN_LIMITS } = await import("../src/prompts/conventions");
    const reviewerLine = TOKEN_LIMITS.split("\n").find(l => l.toLowerCase().includes("reviewer output"));
    expect(reviewerLine).toBeDefined();
    expect(reviewerLine).toContain("1000");
  });
});

// ---------------------------------------------------------------------------
// VAL-RP-010: Sub-agent dispatch instructions are actionable
// ---------------------------------------------------------------------------

describe("Sub-agent dispatch instructions", () => {
  it("locate prompt locator-codebase has concrete task description and return format", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    // Should describe what locator-codebase does and what it returns
    expect(result).toContain("locator-codebase");
    // Should mention returning paths or file references
    expect(result.toLowerCase()).toContain("path");
  });

  it("locate prompt contains the BLOCKING rule for all locators", async () => {
    const { buildResearchLocatePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchLocatePrompt(baseCtx);
    expect(result).toContain("BLOCKING");
    expect(result).toContain("Dispatch locator Tasks first");
  });

  it("analyze prompt analyzer-codebase has concrete task description and return format", async () => {
    const { buildResearchAnalyzePrompt } = await import("../src/prompts/research/index");
    const result = buildResearchAnalyzePrompt(ctxWithPreviousResult);
    expect(result).toContain("analyzer-codebase");
  });
});

// ---------------------------------------------------------------------------
// VAL-RP-011: Plan research prompt instructs .context.md file write
// ---------------------------------------------------------------------------

describe("Plan research prompt .context.md instruction", () => {
  it("explicitly instructs writing to .context.md file", async () => {
    const { buildPlanResearchPrompt } = await import("../src/prompts/plan/research");
    const result = buildPlanResearchPrompt(baseCtx);
    expect(result).toContain(".context.md");
  });

  it("includes file naming convention for .context.md", async () => {
    const { buildPlanResearchPrompt } = await import("../src/prompts/plan/research");
    const result = buildPlanResearchPrompt(baseCtx);
    // Should mention writing a slug-based .context.md file
    expect(result.toLowerCase()).toContain("context.md");
  });

  it("plan research prompt has relaxed token limit (not 500 for research output)", async () => {
    const { buildPlanResearchPrompt } = await import("../src/prompts/plan/research");
    const result = buildPlanResearchPrompt(baseCtx);
    // The old restrictive 500-token research limit should not appear directly
    // It should use the updated TOKEN_LIMITS which has > 500 for research
    // Or the prompt should not impose the old 500 limit
    expect(result).not.toMatch(/Research output:\s*max\s*500\s*tokens/i);
  });
});
