import { describe, it, expect, mock } from "bun:test"
import {
  createActionDispatcher,
  type ActionDispatcherDeps,
} from "../src/tui/components/action-dispatcher"

/** Create fake deps with spies for all callbacks. */
function fakeDeps(overrides?: Partial<ActionDispatcherDeps>): ActionDispatcherDeps {
  return {
    fileExists: () => true,
    notify: mock(() => {}),
    launchWorkWorkflow: mock(() => {}),
    launchGenericWorkflow: mock(() => {}),
    exit: mock(() => {}),
    returnToIdle: mock(() => {}),
    launchStartFlow: mock(() => {}),
    ...overrides,
  }
}

describe("createActionDispatcher", () => {
  // ── /start command routing ──

  it('dispatching "start" calls launchStartFlow with args', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("start", { description: "build a feature" })

    expect(result).toBeNull() // /start is a meta-command, not a workflow
    expect(deps.launchStartFlow).toHaveBeenCalledTimes(1)
    expect(deps.launchStartFlow).toHaveBeenCalledWith({ description: "build a feature" })
  })

  it('dispatching "start" with no args calls launchStartFlow with empty args', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("start", {})

    expect(result).toBeNull()
    expect(deps.launchStartFlow).toHaveBeenCalledTimes(1)
    expect(deps.launchStartFlow).toHaveBeenCalledWith({})
  })

  // ── Existing command behavior (regression) ──

  it('dispatching "exit" calls exit()', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("exit", {})

    expect(result).toBeNull()
    expect(deps.exit).toHaveBeenCalledTimes(1)
  })

  it('dispatching "help" notifies with command list including /start', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("help", {})

    expect(result).toBeNull()
    expect(deps.notify).toHaveBeenCalledTimes(1)
    const message = (deps.notify as ReturnType<typeof mock>).mock.calls[0][0]
    expect(message).toContain("/start")
  })

  it('dispatching "new" calls returnToIdle()', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("new", {})

    expect(result).toBeNull()
    expect(deps.returnToIdle).toHaveBeenCalledTimes(1)
  })

  it('dispatching "work" with valid path returns WorkflowMeta', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("work", { planPath: "my-plan.md" })

    expect(result).toEqual({ stepLabel: "Step", workflowName: "work" })
    expect(deps.launchWorkWorkflow).toHaveBeenCalledTimes(1)
  })

  it('dispatching "plan" with description returns WorkflowMeta', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("plan", { description: "some feature" })

    expect(result).toEqual({ stepLabel: "Step", workflowName: "plan" })
    expect(deps.launchGenericWorkflow).toHaveBeenCalledTimes(1)
  })

  it('dispatching "plan" without description notifies error', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("plan", {})

    expect(result).toBeNull()
    expect(deps.notify).toHaveBeenCalledTimes(1)
    const message = (deps.notify as ReturnType<typeof mock>).mock.calls[0][0]
    expect(message).toContain("Usage")
  })

  it('dispatching unknown workflow notifies error', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("bogus", {})

    expect(result).toBeNull()
    expect(deps.notify).toHaveBeenCalledTimes(1)
    const message = (deps.notify as ReturnType<typeof mock>).mock.calls[0][0]
    expect(message).toContain("Unknown workflow")
  })

  // ── /compound command routing ──

  it('dispatching "compound" calls launchGenericWorkflow with compound command', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("compound", {})

    expect(result).toBeNull() // /compound is a special command
    expect(deps.launchGenericWorkflow).toHaveBeenCalledTimes(1)
    const [name] = (deps.launchGenericWorkflow as ReturnType<typeof mock>).mock.calls[0]
    expect(name).toBe("compound")
  })

  // ── /review target routing ──

  it('dispatching "review" with no target passes default description', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("review", {})

    expect(result).toEqual({ stepLabel: "Step", workflowName: "review" })
    expect(deps.launchGenericWorkflow).toHaveBeenCalledTimes(1)
    const [, args] = (deps.launchGenericWorkflow as ReturnType<typeof mock>).mock.calls[0]
    expect(args.description).toContain("current changes")
  })

  it('dispatching "review" with PR number passes resolved target', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    const result = dispatch("review", { target: "#42" })

    expect(result).toEqual({ stepLabel: "Step", workflowName: "review" })
    const [, args] = (deps.launchGenericWorkflow as ReturnType<typeof mock>).mock.calls[0]
    expect(args.description).toContain("PR #42")
  })

  it('dispatching "review" with bare PR number passes resolved target', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    dispatch("review", { target: "123" })
    const [, args] = (deps.launchGenericWorkflow as ReturnType<typeof mock>).mock.calls[0]
    expect(args.description).toContain("PR #123")
  })

  it('dispatching "review" with GitHub URL passes resolved target', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    dispatch("review", { target: "https://github.com/org/repo/pull/99" })
    const [, args] = (deps.launchGenericWorkflow as ReturnType<typeof mock>).mock.calls[0]
    expect(args.description).toContain("PR #99")
  })

  it('dispatching "review" with branch name passes as description', () => {
    const deps = fakeDeps()
    const dispatch = createActionDispatcher(deps)
    dispatch("review", { target: "feat/auth" })
    const [, args] = (deps.launchGenericWorkflow as ReturnType<typeof mock>).mock.calls[0]
    expect(args.description).toContain("feat/auth")
  })
})
