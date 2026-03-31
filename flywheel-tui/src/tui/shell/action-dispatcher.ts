/**
 * ActionDispatcher — Pure command dispatch logic with dependency injection
 *
 * Both slash commands and contextual UI actions route through the same
 * dispatcher. Extracted from flywheel-shell.tsx so it can be tested
 * without JSX or the OpenTUI runtime.
 *
 * Dependencies are injected via `ActionDispatcherDeps`, making the
 * dispatcher fully testable with fakes.
 */

import os from "node:os"
import type { StepType } from "../../queue/types"

// ---------------------------------------------------------------------------
// Workflow metadata
// ---------------------------------------------------------------------------

export interface WorkflowMeta {
  stepLabel: string
  workflowName: string
}

const WORKFLOW_META: Record<StepType, WorkflowMeta> = {
  work:     { stepLabel: "Step",      workflowName: "work" },
  plan:     { stepLabel: "Step",      workflowName: "plan" },
  review:   { stepLabel: "Step",      workflowName: "review" },
  ship:     { stepLabel: "Step",      workflowName: "ship" },
  debug:    { stepLabel: "Step",      workflowName: "debug" },
  research: { stepLabel: "Step",      workflowName: "research" },
  verify:   { stepLabel: "Step",      workflowName: "verify" },
  gate:     { stepLabel: "Step",      workflowName: "gate" },
}

function isStepType(s: string): s is StepType {
  return s in WORKFLOW_META
}

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

export interface ActionDispatcherDeps {
  fileExists: (path: string) => boolean
  notify: (message: string, variant: string) => void
  launchWorkWorkflow: (planPath: string) => void
  launchGenericWorkflow: (name: string, args: Record<string, string>) => void
  launchStartFlow?: (args: Record<string, string>) => void
  launchTestStep?: (args: Record<string, string>) => void
  exit: () => void
  returnToIdle?: () => void
}

// ---------------------------------------------------------------------------
// Tilde expansion (pure)
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return os.homedir() + p.slice(1)
  }
  return p
}

// ---------------------------------------------------------------------------
// Review target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a review target string into a description.
 * - PR number: `#123` or `123` → "Review PR #123"
 * - GitHub URL: `github.com/.../pull/123` → "Review PR #123"
 * - Branch name or other → "Review: <target>"
 * - Default (no target) → "Review current changes"
 */
function resolveReviewTarget(target: string | undefined): string {
  if (!target) return "Review current changes"

  // PR number: #123 or bare 123
  const prMatch = target.match(/^#?(\d+)$/)
  if (prMatch) return `Review PR #${prMatch[1]}`

  // GitHub PR URL
  const ghMatch = target.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)
  if (ghMatch) return `Review PR #${ghMatch[1]}`

  // Everything else: branch name or description
  return `Review: ${target}`
}

// ---------------------------------------------------------------------------
// Dispatcher factory
// ---------------------------------------------------------------------------

/**
 * Create a dispatch function that routes workflow commands to the
 * appropriate handler.
 *
 * Returns `WorkflowMeta` if a workflow was successfully launched,
 * or `null` for non-workflow commands (exit, help, config) or errors.
 */
export function createActionDispatcher(deps: ActionDispatcherDeps) {
  return (workflow: string, args: Record<string, string>): WorkflowMeta | null => {
    // Handle special commands first
    if (workflow === "exit") {
      deps.exit()
      return null
    }

    if (workflow === "help") {
      deps.notify(
        "Commands: /start, /work, /plan, /review, /ship, /compound, /debug, /research, /config, /exit",
        "info",
      )
      return null
    }

    if (workflow === "new") {
      deps.returnToIdle?.()
      return null
    }

    if (workflow === "config") {
      deps.notify("Not yet implemented: /config", "warning")
      return null
    }

    if (workflow === "start") {
      deps.launchStartFlow?.(args)
      return null
    }

    if (workflow === "test") {
      deps.launchTestStep?.(args)
      return null
    }

    if (workflow === "compound") {
      deps.launchGenericWorkflow("compound", args)
      return null
    }

    // Check if this is a valid workflow type
    if (!isStepType(workflow)) {
      deps.notify(`Unknown workflow: ${workflow}`, "error")
      return null
    }

    const meta = WORKFLOW_META[workflow]

    // "work" workflow — resolve plan path
    if (workflow === "work") {
      const planPath = args.planPath
      if (!planPath) {
        deps.notify("Usage: /work <plan-path>", "error")
        return null
      }

      const resolved = expandTilde(planPath)
      if (!deps.fileExists(resolved)) {
        deps.notify(`File not found: ${planPath}`, "error")
        return null
      }

      deps.launchWorkWorkflow(resolved)
      return meta
    }

    // Non-work workflows — validate required args
    if (workflow === "plan" && !args.description) {
      deps.notify("Usage: /plan <feature description>", "error")
      return null
    }

    if (workflow === "debug" && !args.description) {
      deps.notify("Usage: /debug <problem description>", "error")
      return null
    }

    if (workflow === "research" && !args.topic) {
      deps.notify("Usage: /research <topic>", "error")
      return null
    }

    // Resolve review target into description
    if (workflow === "review") {
      const description = resolveReviewTarget(args.target)
      deps.launchGenericWorkflow(workflow, { ...args, description })
      return meta
    }

    // Start generic workflow
    deps.launchGenericWorkflow(workflow, args)
    return meta
  }
}
