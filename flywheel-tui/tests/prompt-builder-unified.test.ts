import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PhaseInfo } from "../src/controller/phase-provider";
import type { WorkflowStepContext } from "../src/prompts/index";
import { buildWorkPhasePrompt } from "../src/prompts/work/phase-prompt";
// buildPhasePrompt has been deleted — tests for PhaseInfo compatibility with
// the static template are no longer needed since buildWorkPhasePrompt is the
// primary prompt builder for the work path.
import { wrapCompletionInstruction } from "../src/worker/completion";
import { buildWorkflowPrompt } from "../src/workflows/prompt-builder";
import { planWorkflow } from "../src/workflows/plan";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

/**
 * The unified PromptBuilder type.
 * The execution loop will call: wrapCompletionInstruction(builder(phase, ctx))
 */
type PromptBuilder = (phase: PhaseInfo, ctx: WorkflowStepContext) => string;

// ---------------------------------------------------------------------------
// PromptBuilder contract
// ---------------------------------------------------------------------------

describe("Unified PromptBuilder contract", () => {
  const samplePhase: PhaseInfo = {
    index: 0,
    title: "Setup project structure",
    description: "Create the initial project structure and configuration.\n\n- [ ] Create directory layout\n- [ ] Initialize configuration files",
    status: "pending",
    steps: ["Create directory layout", "Initialize configuration files"],
  };

  const sampleCtx: WorkflowStepContext = {
    planContent: samplePhase.description,
    keyDecisions: ["Use TDD approach"],
    fileReferences: ["src/index.ts"],
    previousResult: undefined,
    projectCwd: "/tmp/test-project",
  };

  describe("Work path prompt builder", () => {
    const workPromptBuilder: PromptBuilder = (phase, ctx) =>
      buildWorkPhasePrompt({
        ...ctx,
        planContent: phase.description,
      });

    it("produces prompts using buildWorkPhasePrompt (rich template)", () => {
      const prompt = workPromptBuilder(samplePhase, sampleCtx);

      // Should include the rich template features
      expect(prompt).toContain("# Work Phase Execution");
      expect(prompt).toContain("## Task");
      expect(prompt).toContain("TDD Cycle");
      expect(prompt).toContain("Verification Protocol");
      expect(prompt).toContain("Two-Stage Review");
    });

    it("receives keyDecisions and fileReferences from context", () => {
      const prompt = workPromptBuilder(samplePhase, sampleCtx);

      expect(prompt).toContain("Use TDD approach");
      expect(prompt).toContain("src/index.ts");
    });

    it("receives previousResult when available", () => {
      const ctxWithPrev: WorkflowStepContext = {
        ...sampleCtx,
        previousResult: "Previous phase completed successfully",
      };

      const prompt = workPromptBuilder(samplePhase, ctxWithPrev);
      expect(prompt).toContain("Previous Phase Result");
      expect(prompt).toContain("Previous phase completed successfully");
    });

    it("receives projectCwd", () => {
      const prompt = workPromptBuilder(samplePhase, sampleCtx);
      expect(prompt).toContain("/tmp/test-project");
    });
  });

  describe("Non-work path prompt builder", () => {
    it("uses per-workflow templates (plan workflow)", () => {
      const prompt = buildWorkflowPrompt(
        0,
        planWorkflow,
        { description: "Build a user auth system" },
        undefined,
        "/tmp/project",
      );

      // buildWorkflowPrompt returns raw prompt — the loop adds the completion marker
      expect(prompt).not.toContain("<promise>COMPLETE</promise>");
      // Should contain workflow-specific content
      expect(prompt).toContain("Build a user auth system");
    });

    it("receives previousResult when available", () => {
      const prompt = buildWorkflowPrompt(
        1,
        planWorkflow,
        { description: "Build a user auth system" },
        "Research findings from step 1",
        "/tmp/project",
      );

      // buildWorkflowPrompt passes previousResult through to the template
      expect(prompt).toContain("Research findings from step 1");
    });

    it("raw prompts do not contain completion marker (loop adds it)", () => {
      const prompt = buildWorkflowPrompt(
        0,
        planWorkflow,
        { description: "test" },
      );
      // The loop calls wrapCompletionInstruction, not the builder
      expect(prompt).not.toContain("<promise>COMPLETE</promise>");
    });
  });

  describe("wrapCompletionInstruction", () => {
    it("appends completion marker to any prompt", () => {
      const raw = "Do some work";
      const wrapped = wrapCompletionInstruction(raw);
      expect(wrapped).toContain(raw);
      expect(wrapped).toContain("<promise>COMPLETE</promise>");
    });

    it("can be applied to work prompt builder output", () => {
      const workBuilder: PromptBuilder = (phase, ctx) =>
        buildWorkPhasePrompt({ ...ctx, planContent: phase.description });

      const rawPrompt = workBuilder(samplePhase, sampleCtx);
      const wrappedPrompt = wrapCompletionInstruction(rawPrompt);

      // The rich template already has its own "Completion" section,
      // but the loop adds the machine-readable marker via wrapCompletionInstruction
      expect(wrappedPrompt).toContain("<promise>COMPLETE</promise>");
    });

    it("is idempotent when applied in the loop (not in builders)", () => {
      // The plan: move wrapCompletionInstruction INTO ExecutionLoop.run()
      // so individual builders don't need to call it themselves.
      // The work builder does NOT call wrapCompletionInstruction internally.
      const workBuilder: PromptBuilder = (phase, ctx) =>
        buildWorkPhasePrompt({ ...ctx, planContent: phase.description });

      const rawPrompt = workBuilder(samplePhase, sampleCtx);
      // Raw prompt from buildWorkPhasePrompt has its own completion section
      // but NOT the wrapCompletionInstruction marker format
      expect(rawPrompt).toContain("## Completion");
    });
  });

  describe("PhaseInfo compatibility", () => {
    it("work builder handles phases with steps", () => {
      const phase: PhaseInfo = {
        index: 0,
        title: "Test",
        description: "Build something",
        status: "pending",
        steps: ["Step A", "Step B"],
      };

      const ctx: WorkflowStepContext = {
        planContent: phase.description,
        keyDecisions: [],
        fileReferences: [],
      };

      const prompt = buildWorkPhasePrompt(ctx);
      expect(prompt).toContain("Build something");
    });

    it("work builder handles phases without steps", () => {
      const phase: PhaseInfo = {
        index: 0,
        title: "Test",
        description: "Build something",
        status: "pending",
        steps: undefined,
      };

      const ctx: WorkflowStepContext = {
        planContent: phase.description,
        keyDecisions: [],
        fileReferences: [],
      };

      const prompt = buildWorkPhasePrompt(ctx);
      expect(prompt).toContain("Build something");
    });

    it("work builder handles phases without steps (no static template needed)", () => {
      const phase: PhaseInfo = {
        index: 0,
        title: "Test",
        description: "Build something",
        status: "pending",
        steps: undefined,
      };

      const ctx: WorkflowStepContext = {
        planContent: phase.description,
        keyDecisions: [],
        fileReferences: [],
      };

      // buildWorkPhasePrompt is the primary builder; buildPhasePrompt was removed
      const prompt = buildWorkPhasePrompt(ctx);
      expect(prompt).toContain("Build something");
    });
  });
});
