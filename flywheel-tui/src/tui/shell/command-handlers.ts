/**
 * Command Handlers — factory for workflow launch functions
 *
 * Extracted from flywheel-shell.tsx. These functions route user commands
 * (slash commands) to queue execution. They share a common pattern:
 *   1. Optionally destroy the active chat session (capturing context)
 *   2. Build a Queue from the command arguments
 *   3. Call startQueueExecution()
 *
 * The `/start` flow uses a temporary EventBus + QuestionService to drive
 * a multi-step wizard (description, workflow type, consolidation, review)
 * before building the queue.
 *
 * Dependencies are injected via `CommandHandlerDeps`, following the same
 * `createX({ deps })` convention used by other extracted shell modules.
 */

import fs from "node:fs"
import { EventBus } from "../../events/event-bus"
import type { QuestionRequest } from "../../queue/question-service"
import type { Queue } from "../../queue/types"
import type { WorkflowDeps } from "../../engines/workflow-deps"
import { createQuestionWiring, type QuestionWiring } from "../utils/question-wiring"
import { workflowHasReview, WORKFLOW_OPTIONS, type WorkflowName } from "./start-command"
import { buildQueue, buildQueueForSlashCommand, buildQueueFromPlan } from "./shell-queue"
import { TEST_STEPS, setupTestFixture, buildTestQueue, type TestStepDef } from "../session/test-step"
import { createActionDispatcher } from "./action-dispatcher"
import { exitTUI } from "../app"

// ---------------------------------------------------------------------------
// ToastLike — minimal toast interface (same as other extracted modules)
// ---------------------------------------------------------------------------

export interface ToastLike {
  show(options: { message: string; variant: string; duration?: number }): void
}

// ---------------------------------------------------------------------------
// ChatControllerLike — subset of ChatController used by command handlers
// ---------------------------------------------------------------------------

export interface ChatControllerLike {
  isActive(): boolean
  destroyChat(): Promise<string>
}

// ---------------------------------------------------------------------------
// CommandHandlerDeps — dependency bundle
// ---------------------------------------------------------------------------

export interface CommandHandlerDeps {
  getDepsOrWarn: () => WorkflowDeps | null
  getDepsOrReturnIdle: () => WorkflowDeps | null
  toast: ToastLike
  getProjectCwd: () => string
  chatController: ChatControllerLike
  startQueueExecution: (
    queue: Queue,
    args: Record<string, string>,
    deps?: WorkflowDeps,
    overrides?: { plan?: boolean; review?: boolean },
    seedHandoff?: Record<string, unknown> | null,
  ) => void
  // For question wizard (/start and /test)
  cleanupQuestionSubscriptions: () => void
  setActiveQuestionWiring: (wiring: QuestionWiring | null) => void
  setPendingQuestion: (q: QuestionRequest | null) => void
  // For /test and navigation
  returnToIdle: () => void
  returnToChat: () => void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCommandHandlers(deps: CommandHandlerDeps) {
  /**
   * /work <planPath> — load a plan file and start queue execution.
   */
  const launchWorkWithQueue = async (planPath: string) => {
    const wfDeps = deps.getDepsOrReturnIdle()
    if (!wfDeps) return

    // Destroy chat session before starting workflow (capture context for downstream use)
    const chatContext = deps.chatController.isActive() ? await deps.chatController.destroyChat() : ""

    // Parse the plan file and create work steps from its steps
    const queue = buildQueueFromPlan(planPath, wfDeps.config)
    deps.startQueueExecution(queue, { planPath, ...(chatContext ? { chatContext } : {}) }, wfDeps)
  }

  /**
   * Generic slash command — build a queue from the command name and start execution.
   */
  const launchGenericWithQueue = async (name: string, args: Record<string, string>) => {
    const wfDeps = deps.getDepsOrReturnIdle()
    if (!wfDeps) return

    // Destroy chat session before starting workflow (capture context for downstream use)
    const chatContext = deps.chatController.isActive() ? await deps.chatController.destroyChat() : ""

    const queue = buildQueueForSlashCommand(name, wfDeps.config)
    deps.startQueueExecution(queue, { ...args, ...(chatContext ? { chatContext } : {}) }, wfDeps)
  }

  /**
   * /start flow: guided question wizard that collects a description and
   * queue mode, then starts the appropriate queue.
   *
   * Questions happen BEFORE the queue starts. Uses a temporary EventBus
   * + QuestionService to drive the existing QuestionPrompt component.
   */
  const launchStartFlow = async (args: Record<string, string>) => {
    // Destroy chat session before starting workflow (capture context for downstream use)
    const chatContext = deps.chatController.isActive() ? await deps.chatController.destroyChat() : ""

    // Create a temporary event bus + question wiring for pre-queue questions
    const startBus = new EventBus()
    deps.cleanupQuestionSubscriptions()
    const startWiring = createQuestionWiring({
      eventBus: startBus,
      onQuestion: (q) => deps.setPendingQuestion(q),
      onClear: () => deps.setPendingQuestion(null),
    })
    deps.setActiveQuestionWiring(startWiring)
    const startQS = startWiring.service

    try {
      // Step 1: Get description (skip if already provided via /start <description>)
      let description = args.description ?? ""
      if (!description) {
        const descAnswers = await startQS.ask([{
          question: "What do you want to build?",
          header: "Description",
          options: [],
          textOnly: true,
        }])
        description = descAnswers[0]?.[0] ?? ""
        if (!description) {
          // User dismissed the question
          deps.cleanupQuestionSubscriptions()
          return
        }
      }

      // Step 2: Pick workflow type
      const workflowAnswers = await startQS.ask([{
        question: "How far should the workflow go?",
        header: "Workflow",
        options: WORKFLOW_OPTIONS.map((o) => ({
          label: o.label,
          description: o.description,
        })),
        custom: false,
        default: "Plan + Work + Review",
      }])
      const selectedLabel = workflowAnswers[0]?.[0]
      if (!selectedLabel) {
        // User dismissed
        deps.cleanupQuestionSubscriptions()
        return
      }

      // Map label back to WorkflowName value
      const selectedOption = WORKFLOW_OPTIONS.find((o) => o.label === selectedLabel)
      const workflow: WorkflowName = selectedOption?.value ?? "plan-work-review"

      // Step 3: Consolidation preference (skip for sprint — no planning phase)
      let planInteractive = false
      if (workflow !== "sprint") {
        const consolidationAnswers = await startQS.ask([{
          question: "Do you want to participate in plan consolidation?",
          header: "Consolidation",
          options: [
            { label: "Yes, let me review", description: "Review and consolidate the plan interactively (Recommended)" },
            { label: "No, handle automatically", description: "Auto-consolidate without prompts" },
          ],
          custom: false,
          default: "Yes, let me review",
        }])
        const consolidationLabel = consolidationAnswers[0]?.[0]
        if (!consolidationLabel) {
          deps.cleanupQuestionSubscriptions()
          return
        }
        planInteractive = consolidationLabel === "Yes, let me review"
      }

      // Step 4: Review triage preference (only if workflow includes review)
      let reviewInteractive = false
      if (workflowHasReview(workflow)) {
        const triageAnswers = await startQS.ask([{
          question: "Do you want to triage review findings?",
          header: "Review Triage",
          options: [
            { label: "Yes, let me triage", description: "Review P3 findings interactively (Recommended)" },
            { label: "No, handle automatically", description: "Auto-resolve P3 findings" },
          ],
          custom: false,
          default: "Yes, let me triage",
        }])
        const triageLabel = triageAnswers[0]?.[0]
        if (!triageLabel) {
          deps.cleanupQuestionSubscriptions()
          return
        }
        reviewInteractive = triageLabel === "Yes, let me triage"
      }

      // Clean up question subscriptions before starting queue
      // (queue execution will create its own QuestionService)
      deps.cleanupQuestionSubscriptions()

      // Step 5: Build queue from workflow template and start execution
      // HITL preferences are stored as queue-level metadata and passed to step configs
      const startDeps = deps.getDepsOrWarn()
      if (!startDeps) {
        deps.cleanupQuestionSubscriptions()
        return
      }
      const startFlowQueue = buildQueue(workflow, startDeps.config)
      deps.startQueueExecution(startFlowQueue, { description, ...(chatContext ? { chatContext } : {}) }, startDeps, {
        plan: planInteractive,
        review: reviewInteractive,
      })
    } catch {
      // QuestionRejectedError or other: user dismissed, clean up
      deps.cleanupQuestionSubscriptions()
    }
  }

  /**
   * /test — run a single step type in isolation with fixture data.
   */
  const launchTestStep = async (args: Record<string, string>) => {
    // If stepName provided as argument, look it up directly
    const directMatch = args.stepName
      ? TEST_STEPS.find((s) => s.id === args.stepName)
      : null

    let selectedStep: TestStepDef | null = directMatch ?? null

    if (!selectedStep) {
      // Show picker
      deps.cleanupQuestionSubscriptions()
      const startBus = new EventBus()
      const startWiring = createQuestionWiring({
        eventBus: startBus,
        onQuestion: (q) => deps.setPendingQuestion(q),
        onClear: () => deps.setPendingQuestion(null),
      })
      deps.setActiveQuestionWiring(startWiring)

      try {
        const qs = startWiring.service

        const stepOptions = TEST_STEPS.map((s) => ({
          label: s.label,
          description: `${s.type} step (${s.dispatcherHint ?? s.type})`,
        }))

        const answers = await qs.ask([{
          question: "Which step type do you want to test?",
          header: "Test Step",
          options: stepOptions,
        }])

        deps.cleanupQuestionSubscriptions()
        const selectedLabel = answers[0]?.[0]
        if (selectedLabel) {
          selectedStep = TEST_STEPS.find((s) => s.label === selectedLabel) ?? null
        }
      } catch {
        deps.cleanupQuestionSubscriptions()
        return
      }
    }

    if (!selectedStep) {
      deps.toast.show({ message: "No step selected", variant: "warning" })
      return
    }

    // Set up fixture files
    const wfDeps = deps.getDepsOrReturnIdle()
    if (!wfDeps) return
    const projectCwd = wfDeps.config.project_cwd ?? process.cwd()
    const fixture = setupTestFixture(selectedStep, projectCwd)

    // Build single-step queue
    const queue = buildTestQueue(selectedStep, fixture)

    // Launch it through the normal queue execution path
    const testArgs: Record<string, string> = {
      description: `[test] ${selectedStep.label}`,
    }
    deps.startQueueExecution(queue, testArgs, wfDeps, undefined, fixture.handoffData)
  }

  return {
    launchWorkWithQueue,
    launchGenericWithQueue,
    launchStartFlow,
    launchTestStep,
  }
}

// ---------------------------------------------------------------------------
// Dispatch wiring helper
// ---------------------------------------------------------------------------

/**
 * Create the ActionDispatcher wired to command handlers and navigation actions.
 *
 * Extracted alongside the command handlers since the dispatch wiring was
 * co-located with the handler definitions in the shell.
 */
export function createShellDispatcher(
  handlers: ReturnType<typeof createCommandHandlers>,
  deps: {
    toast: ToastLike
    returnToIdle: () => void
    returnToChat: () => void
  },
) {
  return createActionDispatcher({
    fileExists: (path) => fs.existsSync(path),
    notify: (message, variant) => {
      deps.toast.show({
        message,
        variant: variant as "info" | "error" | "warning",
        ...(variant === "info" ? { duration: 8000 } : {}),
      })
    },
    launchWorkWorkflow: handlers.launchWorkWithQueue,
    launchGenericWorkflow: handlers.launchGenericWithQueue,
    launchStartFlow: handlers.launchStartFlow,
    launchTestStep: handlers.launchTestStep,
    exit: exitTUI,
    returnToIdle: deps.returnToIdle,
    returnToChat: deps.returnToChat,
  })
}
