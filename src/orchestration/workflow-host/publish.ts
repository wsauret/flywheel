import { Result, Schema } from "effect"
import { hashContent } from "../../workflows/definition-hash.js"
import { describeClosureFailure } from "../../workflows/definition-validation.js"
import { buildContextInputSeededFact } from "../../workflows/context-bundle/context-facts.js"
import { queueFactsForState } from "../../workflows/view/view-diff.js"
import { resolveWorkflowAgents, type ResolvedAgent } from "../../workflows/agent-resolution.js"
import { agentRecords, type WorkflowDefinition } from "../../workflows/workflow-schema.js"
import type { WorkflowVerificationResult } from "../../workflows/vm/verify-types.js"
import { workflowInputContract } from "../../workflows/brief.js"
import { decodeWorkflowInput, type WorkflowInputValue } from "../../workflows/output-contract/compile.js"
import { commandEvidenceRefusal } from "../../workflows/output-contract/envelope.js"
import type { AgentDefinition } from "../../infra/agent-definition.js"
import { disabledToolReason } from "../tool-catalog.js"
import type { FirstPartyModuleComposition } from "../modules.js"
import type { ProjectDefinitionRegistryRevision } from "../../workflows/definition-registry.js"
import { compileWorkflowControl, launchGuardrailLimits } from "../../workflows/vm/compile.js"
import { worstCaseAttempts } from "../../workflows/vm/structural-admission.js"
import { flattenWorkflowView } from "../../workflows/vm/view-flatten.js"
import {
  buildWorkflowControlInitializedFact,
  parseWorkflowSessionFact,
  type WorkflowSessionFact,
} from "../../workflows/vm/session-facts.js"
import { bindWorkflowAgentModels, type WorkflowAgentModels } from "../config/workflow-agent-models.js"
import type { SessionManager } from "../session/manager.js"
import type { RuntimeWorkflowInvocation, WorkflowLaunchBinding } from "../session/child-session-publication.js"
import type { InFlightSwap } from "../../infra/event-store-types.js"
import type { RoleSettings } from "../session/schemas.js"
import { buildWorkflowDefinitionLineageFacts } from "./definition-lineage.js"
import type { WorkflowDeps } from "./deps.js"
import type { CommittedWorkflowControl } from "../../workflows/vm/committed-control.js"
import type { WorkflowLaunchAgentModels } from "../../infra/workflow-types.js"

/** A launch whose agents require a package the captured registry revision does
 *  not install. Startup validation cannot decide this: packages hot reload, so
 *  a package present when definitions loaded can be gone by launch time. The
 *  launch is refused before compilation, never later at prompt assembly. */
export class WorkflowRequiredSkillsMissingError extends Schema.TaggedError<WorkflowRequiredSkillsMissingError>()(
  "WorkflowRequiredSkillsMissingError",
  {
    workflowDefinitionId: Schema.String,
    message: Schema.String,
  },
) {}

/** A launch whose structured input the workflow cannot take: the workflow
 *  declares no input contract, or the input does not decode against it. The
 *  launch is refused before any session, fact, or worker exists. `message`
 *  names each key path at fault and says how to correct the input. */
export class WorkflowInputRejectedError extends Schema.TaggedError<WorkflowInputRejectedError>()(
  "WorkflowInputRejectedError",
  {
    workflowDefinitionId: Schema.String,
    message: Schema.String,
  },
) {}

/** Decode the structured input of one launch against the workflow's input
 *  contract, or refuse the launch. Null is a launch without input: a
 *  workflow without a contract, or a launch that passed none to a contract
 *  that requires no field. Only a model launch carries input, so a launch
 *  that passed none to a contract with a required field, such as a person's
 *  slash launch, is refused with words that say how an agent passes it. */
function decodeLaunchInput(workflow: WorkflowDefinition, value: unknown): WorkflowInputValue | null {
  const contract = workflowInputContract(workflow)
  if (contract === null) {
    if (value === undefined) return null
    throw new WorkflowInputRejectedError({
      workflowDefinitionId: workflow.id,
      message: `Workflow "${workflow.id}" declares no input contract, so it takes no input. Launch it again without input, and put the details in the description.`,
    })
  }
  const decoded = decodeWorkflowInput(contract, value ?? {})
  const issues = (failure: readonly string[]): string => failure.map((line) => `- ${line}`).join("\n")
  if (Result.isSuccess(decoded)) return value === undefined ? null : decoded.success
  throw new WorkflowInputRejectedError({
    workflowDefinitionId: workflow.id,
    message: value === undefined
      ? `Workflow "${workflow.id}" requires structured input, and this launch passed none:\n${issues(decoded.failure)}\nOnly an agent launch can pass input: an agent passes it as the input object of the workflow tool. Ask a chat agent to launch this workflow.`
      : `Workflow "${workflow.id}" refused its input:\n${issues(decoded.failure)}\nCorrect the input to match the input schema of the workflow, then launch it again.`,
  })
}

export interface PreparedWorkflowLaunch {
  readonly description: string
  readonly workflowDefinitionId: string
  readonly initialRoles: RoleSettings
  readonly authProfileId: string
  readonly workflowFacts: readonly WorkflowSessionFact[]
  /** The most attempts the launched control can queue: its worst case
   *  (refer to `worstCaseAttempts`), which counts every attempt it holds,
   *  each unexpanded list at its declared width, each declared retry, and
   *  the inserts that `max_inserts` allows, capped at `max_attempts`, which
   *  the runtime never passes. A workflow file that declares no
   *  `max_attempts` runs with its worst case as its attempt limit. */
  readonly worstCaseAttempts: number
  /** The model and effort that the launch bound for its agents, which the
   *  launch result states. */
  readonly stepModels: WorkflowAgentModels
}

interface PrepareWorkflowLaunchInput {
  /** The definition admission resolved for this launch. */
  workflow: WorkflowDefinition
  description: string
  deps: WorkflowDeps
  /** Durable session profile. It can differ from deps.activeProfileId when an
   *  environment selector supplies the effective request profile. */
  authProfileId: string
  /** Selected project root. Persona resolution reads `.flywheel/agents` under
   *  it, so an embedded or headless launch pins the project's personas instead
   *  of whatever directory the process started in. */
  projectRoot: string
  /** Complete project-definition revision captured at operation admission. */
  definitionRevision: ProjectDefinitionRegistryRevision
  /** The structured launch input as the caller passed it, before decoding.
   *  Absent when the caller passed none. */
  input?: unknown
  /** Approved parent checkpoint intent, rendered with source identity at launch. */
  inheritedIntent?: string
  agents?: WorkflowLaunchAgentModels
  /** The verifier result of a workflow file's launch. */
  verification?: WorkflowVerificationResult
  /** What the path pipeline warned about a workflow file, one short
   *  located line each. */
  warnings?: readonly string[]
  buildDefinitionLineageFacts?: typeof buildWorkflowDefinitionLineageFacts
}

/** Prepare every fact of one launch without writing any. Unknown agent ids
 *  and overlapping file and launch keys are refused before compilation.
 *  A refused input throws `WorkflowInputRejectedError`. Model settings never refuse publication. */
export async function prepareWorkflowLaunch(input: PrepareWorkflowLaunchInput): Promise<PreparedWorkflowLaunch> {
  const revision = input.definitionRevision
  const { workflow } = input
  const records = agentRecords(workflow)
  for (const definitionId of Object.keys(input.agents ?? {})) {
    const record = records.get(definitionId)
    if (record === undefined) throw new Error(`Workflow "${workflow.id}" has no agent "${definitionId}".`)
    if (record.keys.model !== undefined || record.keys.effort !== undefined) {
      throw new Error(`Workflow "${workflow.id}" agent "${definitionId}" sets model or effort in both the file and the launch. Use only one source.`)
    }
  }
  const launchInput = decodeLaunchInput(workflow, input.input)
  const { control: compiled, resolvedAgents } = prepareControl(workflow, input, null, launchInput)
  refuseUncitableAgents(workflow, resolvedAgents, input.deps.moduleSelection(), revision.personas)
  const skills = revision.skills
  const initialQueue = flattenWorkflowView(compiled, resolvedAgents)
  const capture = await input.deps.captureProviderConnection()
  const bound = await bindWorkflowAgentModels({
    workflow,
    ...(input.agents === undefined ? {} : { agents: input.agents }),
    resolvedAgents,
    userDataRoot: input.deps.userDataRoot,
    capture,
    personas: revision.personas,
  })
  const initialRoles = bound.roles
  const worstCase = Math.min(worstCaseAttempts(compiled), compiled.guardrails.maxAttempts)
  const inputSeed = buildContextInputSeededFact(workflow.id, input.description, launchInput, input.inheritedIntent)
  const definitionLineage = (input.buildDefinitionLineageFacts ?? buildWorkflowDefinitionLineageFacts)({
    workflow,
    agents: [...resolvedAgents.values()],
    skills,
    attempts: initialQueue.attempts,
    userRequestSha256: hashContent(inputSeed.payload.userRequest).sha256,
    worstCaseAttempts: worstCase,
    verification: input.verification ?? null,
    warnings: input.warnings ?? [],
  })
  const queueFacts = queueFactsForState(null, initialQueue)
  const launchCompanions = [...definitionLineage, inputSeed, ...queueFacts]
  const control = { ...compiled, aggregateSeq: launchCompanions.length }
  const workflowFacts = [
    ...definitionLineage,
    inputSeed,
    buildWorkflowControlInitializedFact(control),
    ...queueFacts,
  ].map(parseWorkflowSessionFact)
  return {
    description: input.description,
    workflowDefinitionId: workflow.id,
    authProfileId: input.authProfileId,
    initialRoles,
    workflowFacts,
    worstCaseAttempts: worstCase,
    stepModels: bound.models,
  }
}

/** Resolve admitted agents and retain a recoverable control basis.
 * Compilation is needed only when the current root has no readable control
 * prefix. `launchInput` is the decoded structured input of the launch,
 * which a phase over the launch input expands over; recovery passes the
 * input that the launch recorded. Compilation runs structural admission
 * with the launch's guardrails (refer to `launchGuardrailLimits`), so a
 * graph that the attempt limit refuses throws
 * `WorkflowStructureRejectedError`, which names each finding and its
 * remedy, before any fact is written. A recovery basis was admitted when it
 * launched, so recovery does not judge it again. */
export function prepareWorkflowAgents(
  input: Pick<PrepareWorkflowLaunchInput, "workflow" | "definitionRevision" | "deps">,
  basis: CommittedWorkflowControl | null = null,
  launchInput: WorkflowInputValue | null = null,
) {
  return prepareControl(input.workflow, input, basis, launchInput)
}

function prepareControl(
  workflow: WorkflowDefinition,
  input: Pick<PrepareWorkflowLaunchInput, "definitionRevision" | "deps">,
  basis: CommittedWorkflowControl | null,
  launchInput: WorkflowInputValue | null,
) {
  const revision = input.definitionRevision
  const resolvedAgents = resolveLaunchAgents(workflow, revision)
  const control = basis ?? compileWorkflowControl(workflow, resolvedAgents, {
    skills: revision.skills,
    personas: revision.personas,
  }, launchGuardrailLimits(workflow, input.deps.captureRuntimeConfig().workflow.max_attempts), launchInput)
  return { control, resolvedAgents }
}

/** Resolve this launch's agents against the captured revision, or refuse
 *  the launch. Startup validation cannot decide this: packages and personas
 *  hot reload, so a package present when definitions loaded, a dependency
 *  of one, or the persona that an agent runs as can be gone by launch time.
 *  The refusal happens before compilation, never later at prompt assembly
 *  or dispatch. */
function resolveLaunchAgents(
  workflow: WorkflowDefinition,
  revision: ProjectDefinitionRegistryRevision,
): ReadonlyMap<string, ResolvedAgent> {
  const refuse = (message: string): never => {
    throw new WorkflowRequiredSkillsMissingError({ workflowDefinitionId: workflow.id, message })
  }
  let resolvedAgents: ReadonlyMap<string, ResolvedAgent>
  try {
    resolvedAgents = resolveWorkflowAgents(workflow)
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err))
  }
  for (const agent of resolvedAgents.values()) {
    const failure = describeClosureFailure(agent.dependencies, revision.skills, `Workflow "${workflow.id}" agent "${agent.definitionId}"`)
    if (failure) return refuse(failure)
    if (agent.persona !== undefined && revision.personas.get(agent.persona)?.kind !== "persona") {
      return refuse(`Workflow "${workflow.id}" agent "${agent.definitionId}" runs as persona "${agent.persona}", which no installed persona provides. Install the persona or remove persona from the agent.`)
    }
  }
  return resolvedAgents
}

/** Refuse a launch with an agent whose contract sets `commands.min` but that
 *  cannot call bash: the workflow's modules leave Bash off, or the persona
 *  it runs as declares no bash. No call of such an agent can be cited, so it
 *  could never hand off. */
function refuseUncitableAgents(
  workflow: WorkflowDefinition,
  resolvedAgents: ReadonlyMap<string, ResolvedAgent>,
  modules: FirstPartyModuleComposition,
  personas: ReadonlyMap<string, AgentDefinition>,
): void {
  const shellOff = disabledToolReason("bash", modules)
  for (const agent of resolvedAgents.values()) {
    if (!agent.output.requiresCommandEvidence) continue
    const label = `Workflow "${workflow.id}" agent "${agent.definitionId}"`
    if (shellOff !== undefined) throw new Error(commandEvidenceRefusal(label, shellOff))
    const persona = agent.persona === undefined ? undefined : personas.get(agent.persona)
    if (persona?.kind === "persona" && !new Set(persona.tools).has("bash")) {
      throw new Error(`${label} needs command evidence, and its persona "${agent.persona}" declares no bash tool. Run it as a persona that declares bash, or remove commands from its output.`)
    }
  }
}

interface PublishWorkflowInput {
  manager: SessionManager
  prepared: PreparedWorkflowLaunch
  launchedFrom: WorkflowLaunchBinding
  summary?: string
  runtimeInvocation?: RuntimeWorkflowInvocation
  executionCwd?: string
  workflowId?: string
  retainedOperation?: InFlightSwap
}

export async function publishWorkflow(input: PublishWorkflowInput): Promise<string> {
  const workflowId = input.workflowId ?? input.manager.allocateId()
  return input.manager.publishWorkflow({
    id: workflowId,
    description: input.prepared.description,
    workflowDefinitionId: input.prepared.workflowDefinitionId,
    authProfileId: input.prepared.authProfileId,
    initialRoles: input.prepared.initialRoles,
    facts: input.prepared.workflowFacts,
    ...(input.executionCwd ? { executionCwd: input.executionCwd } : {}),
    launchedFrom: input.launchedFrom,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.runtimeInvocation ? { runtimeInvocation: input.runtimeInvocation } : {}),
    ...(input.retainedOperation ? { retainedOperation: input.retainedOperation } : {}),
  })
}
