/**
 * Scrutiny validation prompt template.
 *
 * Generates the prompt for scrutiny validation steps that are auto-injected
 * at milestone boundaries. Instructs the worker to:
 *
 * 1. Run test/typecheck/lint as hard gates (commands from config, not hardcoded)
 * 2. Review each completed step in the milestone for code quality, correctness,
 *    and test coverage
 * 3. Synthesize findings into a scrutiny report
 *
 * Adapted from multi-agent mission system scrutiny validation patterns.
 *
 * Fulfills: VAL-EXEC-003, VAL-EXEC-004, VAL-EXEC-011
 */

import type { CommandsConfig } from "../../config/loader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal step data needed for per-step review instructions.
 */
export interface ScrutinyStepInfo {
  /** 0-based index */
  index: number;
  /** Step title */
  title: string;
  /** Step description */
  description: string;
}

/**
 * Context needed to build a scrutiny validation prompt.
 */
export interface ScrutinyPromptContext {
  /** Name of the milestone being validated */
  milestoneName: string;
  /** Steps in this milestone that have been completed */
  completedSteps: ScrutinyStepInfo[];
  /** Commands from config (flywheel.toml [commands] section) */
  commands?: CommandsConfig;
  /** Project working directory */
  projectCwd?: string;
}

// ---------------------------------------------------------------------------
// Hard gates section
// ---------------------------------------------------------------------------

type CommandType = "test" | "typecheck" | "lint";

const COMMAND_LABELS: Record<CommandType, string> = {
  test: "Test Suite",
  typecheck: "Typecheck",
  lint: "Lint",
};

/**
 * Build the hard gates section from configured commands.
 *
 * For each command type (test, typecheck, lint):
 * - If configured: include the exact command string as a hard gate
 * - If not configured: include a warning note (but do not fail the section)
 *
 * VAL-EXEC-003: Configured commands are hard gates — any failure fails validation.
 * VAL-EXEC-011: Commands are read from config, not hardcoded.
 */
function buildHardGatesSection(commands?: CommandsConfig): string {
  const types: CommandType[] = ["test", "typecheck", "lint"];

  const configuredGates: string[] = [];
  const warnings: string[] = [];

  for (const type of types) {
    const cmd = commands?.[type];
    if (cmd) {
      configuredGates.push(
        `### ${COMMAND_LABELS[type]}\n\`\`\`\n${cmd}\n\`\`\`\nRun this command. If it exits with a non-zero exit code, the scrutiny validation **fails immediately**. Do not proceed to code review.`,
      );
    } else {
      warnings.push(
        `- **${COMMAND_LABELS[type]}:** Not configured in \`flywheel.toml [commands]\`. Skipping this gate.`,
      );
    }
  }

  const sections: string[] = [];

  sections.push("## Hard Gate Validators");
  sections.push("");
  sections.push(
    "Run each configured command below **in order**. These are hard gates — if ANY configured command fails (non-zero exit code), the scrutiny validation step **fails**. Do not continue to code review if a gate fails.",
  );
  sections.push("");

  if (configuredGates.length > 0) {
    sections.push(configuredGates.join("\n\n"));
  }

  if (warnings.length > 0) {
    sections.push("");
    sections.push("### Commands Not Configured");
    sections.push("");
    sections.push(
      "The following commands are not configured in the project's `flywheel.toml` `[commands]` section. They will be skipped (this is a warning, not a failure):",
    );
    sections.push("");
    sections.push(warnings.join("\n"));
  }

  if (configuredGates.length === 0) {
    sections.push("");
    sections.push(
      "**Warning:** No commands are configured. All hard gate validators will be skipped. Proceed directly to code review.",
    );
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Per-step review section
// ---------------------------------------------------------------------------

/**
 * Build the per-step code review section.
 *
 * Lists each completed step with its description and instructs the worker
 * to review for code quality, correctness, and test coverage.
 *
 * VAL-EXEC-004: Scrutiny prompt instructs review of each completed step.
 */
function buildStepReviewSection(
  completedSteps: ScrutinyStepInfo[],
  milestoneName: string,
): string {
  const sections: string[] = [];

  sections.push("## Per-Step Code Review");
  sections.push("");
  sections.push(
    `Review each completed step in milestone "${milestoneName}" for code quality, correctness, and test coverage.`,
  );
  sections.push("");

  if (completedSteps.length === 0) {
    sections.push("_No completed steps found in this milestone._");
    return sections.join("\n");
  }

  sections.push("For **each step** listed below, review the implementation and check:");
  sections.push("");
  sections.push("1. **Code quality:** Clean, readable, idiomatic code. No dead code, proper error handling, consistent style.");
  sections.push("2. **Correctness:** Implementation matches the step description. Edge cases handled. No regressions.");
  sections.push("3. **Test coverage:** Meaningful tests exist for the new behavior. Tests cover happy path and error cases.");
  sections.push("");

  for (const step of completedSteps) {
    sections.push(`### Step ${step.index + 1}: ${step.title}`);
    sections.push("");
    sections.push(`**Description:** ${step.description}`);
    sections.push("");
    sections.push(
      `Review the code changes for this step. Use \`git log\` and \`git diff\` to identify relevant commits and changes. Check that the implementation satisfies the description above.`,
    );
    sections.push("");
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the complete scrutiny validation prompt.
 *
 * Adapted from multi-agent mission system scrutiny validation patterns.
 *
 * @param ctx - Scrutiny prompt context with milestone, steps, and commands
 * @returns Complete prompt string
 */
export function buildScrutinyPrompt(ctx: ScrutinyPromptContext): string {
  const { milestoneName, completedSteps, commands, projectCwd } = ctx;

  const sections: string[] = [];

  // Header
  sections.push(`# Scrutiny Validation: ${milestoneName}`);
  sections.push("");
  sections.push(
    `You are validating milestone "${milestoneName}". Your job is to run hard gate validators ` +
    `(test, typecheck, lint) and then review each completed step for code quality, correctness, and test coverage.`,
  );
  sections.push("");
  sections.push(
    "**If any hard gate validator fails, the entire scrutiny validation fails immediately.** " +
    "Do not proceed to code review if a gate fails. Report the failure with the command, exit code, and error output.",
  );

  // Working directory
  if (projectCwd) {
    sections.push("");
    sections.push(`## Working Directory`);
    sections.push("");
    sections.push(`\`${projectCwd}\``);
  }

  // Hard gates
  sections.push("");
  sections.push(buildHardGatesSection(commands));

  // Per-step review
  sections.push("");
  sections.push(buildStepReviewSection(completedSteps, milestoneName));

  // Synthesis instructions
  sections.push("");
  sections.push("## Synthesis");
  sections.push("");
  sections.push("After completing all hard gate checks and per-step reviews, synthesize your findings:");
  sections.push("");
  sections.push("1. **Gate results:** For each command run, report: command, exit code, pass/fail.");
  sections.push("2. **Review findings:** For each step reviewed, report: step title, status (pass/fail), and any issues found.");
  sections.push("3. **Blocking issues:** Any issue that must be fixed before the milestone can proceed. Include severity, description, and suggested fix.");
  sections.push("4. **Overall verdict:** Pass (all gates passed, no blocking issues) or Fail (gate failure or blocking issues).");
  sections.push("");
  sections.push("Be specific in your findings. Cite file paths and line numbers. Provide actionable suggestions for any issues found.");

  return sections.join("\n");
}
