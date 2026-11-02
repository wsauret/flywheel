import { basename, dirname, resolve } from "node:path"
import { Schema } from "effect"
import type { ProjectDirectories } from "../../../../infra/directory-authorities.js"
import { errorMessage } from "../../../../infra/error-message.js"
import type { SkillRegistryRevision } from "../../../../workflows/skill-schema.js"
import { formatDefinitionError, type DefinitionError } from "../../../../workflows/definition-provenance.js"
import { loadWorkflowFile, workflowDiagnosticText } from "../../../../workflows/workflow-file.js"
import { resolveWorkflowAgents } from "../../../../workflows/agent-resolution.js"
import type { WorkflowDefinition } from "../../../../workflows/workflow-schema.js"
import type { WorkflowVerificationReport } from "../../../../workflows/vm/verify-types.js"
import { verifyAuthoredWorkflow, verifyInstantiatedWorkflow, verifyRecoveredWorkflow } from "../../../../workflows/vm/verify.js"
import { CorruptEventRowError, type StoredFact } from "../../../../infra/event-store-types.js"
import { openReadonlyEventReader } from "../../../../infra/sqlite-event-store.js"
import { resolveEventStoreDbFile } from "../../../../infra/paths.js"
import type { WorkflowTree, WorkflowTreeJoin, WorkflowTreePhase } from "../../../../protocol/workflow-view-protocol-types.js"
import { loadAccumulatedContextFromEvents } from "../../../../workflows/context-bundle/context-projection.js"
import { describeWorkflowRecoveryDegradation, recoverWorkflowControl } from "../../../../workflows/vm/recovery.js"
import { parseWorkflowSessionFact, workflowAggregateId } from "../../../../workflows/vm/session-facts.js"
import { loadQueueFromEvents } from "../../../../workflows/view/view-projection.js"
import { CoverageOutputSchema } from "../../../../workflows/reducers/coverage.js"
import { requireReducer } from "../../../../workflows/reducers/registry.js"
import type { ReducerOutput, SelectionEntry } from "../../../../workflows/reducers/reducer.js"
import type { FieldMap } from "../../../../workflows/output-contract/grammar.js"
import type { CommittedWorkflowControl } from "../../../../workflows/vm/committed-control.js"
import { coverageText, selectionText, roundTarget } from "../../../../protocol/client/workflow-progress.js"
import { prepareWorkspaceState } from "../../../workspace-state.js"
import { createInstalledDefinitionRegistry } from "../../../definition-catalog.js"

interface WorkflowVerifyDependencies {
  /** Revision the verified identity is composed from, so a report describes the
   *  packages this project has installed now. */
  readonly skills: SkillRegistryRevision
  readonly readText: (path: string) => Promise<string>
}

/** One-off command: a short-lived registry for the project the caller selected,
 *  so verification reads the same definitions a run in this project would.
 *
 *  Verification is read-only inspection. It admits no optional capability and
 *  reconciles no global skill store, so it neither builds a capability policy nor
 *  writes anything a managed-learning mutation would. A package left
 *  hidden by an interrupted global operation is simply absent from this report,
 *  which is what the project installs right now. */
function projectDependencies(directories: ProjectDirectories): WorkflowVerifyDependencies {
  const revision = createInstalledDefinitionRegistry(directories).captureRevision()
  return {
    skills: revision.skills,
    readText: (path) => Bun.file(path).text(),
  }
}

export function renderWorkflowVerificationReport(report: WorkflowVerificationReport): string {
  const lines = [`Result: ${report.result}`, ""]
  if (report.findings.length === 0) {
    lines.push("Findings: none")
  } else {
    lines.push("Findings:")
    for (const finding of report.findings) {
      const target = finding.target === null ? "" : ` [${finding.target}]`
      lines.push(`- ${finding.name}${target}: ${finding.message}`)
      lines.push(finding.witness === null
        ? `  No path: ${finding.noPathReason}`
        : `  Event witness: ${finding.witness.length === 0 ? "(initial state)" : finding.witness.join(" -> ")}`)
    }
  }

  lines.push("")
  if (report.uncertainties.length === 0) {
    lines.push("Uncertainties: none")
  } else {
    lines.push("Uncertainties:")
    for (const item of report.uncertainties) {
      const target = item.target === null ? "" : ` [${item.target}]`
      lines.push(`- ${item.name}${target}: ${item.detail}`)
    }
  }
  return lines.join("\n")
}

/** Verify a workflow file as a chat path launch, or an instantiated JSON file.
 *  Decode and semantic errors throw one message with every file diagnostic.
 *  A named workflow id is refused with instructions to pass a file path. */
export async function resolveWorkflowVerifyInput(
  input: string,
  dependencies: WorkflowVerifyDependencies,
): Promise<WorkflowVerificationReport> {
  const verify = (workflow: WorkflowDefinition): WorkflowVerificationReport =>
    verifyAuthoredWorkflow(workflow, resolveWorkflowAgents(workflow), { skills: dependencies.skills })
  const lowerInput = input.toLowerCase()
  if (lowerInput.endsWith(".yaml") || lowerInput.endsWith(".yml")) {
    const content = await readDefinitionFile(input, dependencies)
    const absolute = resolve(input)
    const loaded = loadWorkflowFile({
      file: input,
      content,
      location: { root: { kind: "directory", dir: dirname(absolute) }, path: basename(absolute) },
      provenance: { layer: "session", filePath: input },
      skills: dependencies.skills,
    })
    if (!loaded.ok) {
      throw definitionErrors(loaded.diagnostics.map((diagnostic) => ({
        file: input,
        ...(loaded.id === undefined ? {} : { id: loaded.id }),
        message: workflowDiagnosticText(diagnostic),
      })))
    }
    return verify(loaded.workflow)
  }

  if (lowerInput.endsWith(".json")) {
    return verifyInstantiatedWorkflow(JSON.parse(await readDefinitionFile(input, dependencies)))
  }

  throw new Error(`Named workflow verification is no longer supported: ${input}. Pass a workflow file path (.yaml, .yml, or .json).`)
}

function definitionErrors(errors: readonly DefinitionError[]): Error {
  return new Error(`Workflow definition errors:\n${errors.map(formatDefinitionError).join("\n")}`)
}

async function readDefinitionFile(path: string, dependencies: WorkflowVerifyDependencies): Promise<string> {
  try {
    return await dependencies.readText(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`File not found: ${path}`, { cause: error })
    throw error
  }
}

/** One workflow as its stored facts replay it now: whether its
 *  control replays, the verifier's findings from the state it is in, its
 *  operational tree, and the records its workflow scope leaves out of
 *  context, each with its reason. It reads the store and writes nothing. */
interface WorkflowRunVerification {
  readonly workflowId: string
  readonly text: string
  readonly sound: boolean
}

/** Replay one workflow's facts through the same control loading a
 *  resumed run uses. `facts` is the tolerant read of the workflow
 *  aggregate, so an unreadable row is a stated gap and not a crash. */
function verifyWorkflowRun(workflowId: string, facts: readonly (StoredFact | CorruptEventRowError)[]): WorkflowRunVerification {
  const lines = [`Workflow: ${workflowId}`]
  if (facts.length === 0) return { workflowId, text: [...lines, "No facts are stored for this workflow."].join("\n"), sound: false }
  const plan = recoverWorkflowControl(facts)
  const stored = facts.filter((fact): fact is StoredFact => !(fact instanceof CorruptEventRowError))
  if (!plan.executable) {
    lines.push("Control: cannot be replayed", ...plan.reasons.map((reason) => `- ${describeWorkflowRecoveryDegradation(reason)} (${reason.kind})`))
    try {
      const queue = loadQueueFromEvents(stored)
      if (queue !== null) lines.push("", "Tree:", ...treeLines(queue.tree, new Map()))
    } catch (error) {
      lines.push(`Tree: unavailable, ${errorMessage(error)}`)
    }
    return { workflowId, text: lines.join("\n"), sound: false }
  }
  const control = plan.control
  lines.push(`Workflow: ${control.definitionIdentity.workflowDefinitionId}`, `Control: replays, status ${control.status}`, "")
  const report = verifyRecoveredWorkflow(control)
  lines.push(renderWorkflowVerificationReport(report), "")
  const queue = loadQueueFromEvents(stored)
  if (queue === null) {
    lines.push("Tree: unavailable, no workflow view is stored")
    return { workflowId, text: lines.join("\n"), sound: false }
  }
  lines.push("Tree:", ...treeLines(queue.tree, settledJoins(stored, control)))
  lines.push("", ...contextExclusionLines(stored))
  return { workflowId, text: lines.join("\n"), sound: report.result !== "invalid" }
}

/** Every node of the tree on its own line, indented under its owner, with
 *  its kind, id, disposition, and reason, and each list's join and coverage
 *  below it. */
function treeLines(tree: WorkflowTree, joins: ReadonlyMap<string, SettledJoin>): readonly string[] {
  const parents = new Map(tree.nodes.map((node) => [node.id, node.parentId]))
  const depthOf = (id: string): number => {
    let depth = 0
    for (let parent = parents.get(id) ?? null; parent !== null; parent = parents.get(parent) ?? null) depth += 1
    return depth
  }
  const lastPhases = new Map(tree.nodes.flatMap((node) => node.kind === "phase" && node.list !== undefined ? [[node.list.id, node.id] as const] : []))
  return tree.nodes.flatMap((node) => {
    const indent = "  ".repeat(depthOf(node.id) + 1)
    const current = node.id === tree.currentAgentNodeId ? ", current" : ""
    const reason = node.reason === undefined ? "" : `. ${node.reason}`
    // One phase lists the agent of every item, so an agent line names its item.
    const label = node.kind === "agent" && node.item !== undefined ? `${node.label} · ${node.item.label}` : node.label
    const line = `${indent}${label} [${node.kind} ${node.id}]: ${node.disposition}${current}${reason}`
    if (node.kind === "repeat") return [line, `${indent}  Loop: round ${node.loop.iteration} of at most ${node.loop.maxIterations}${node.loop.outcome === undefined ? "" : `, ${node.loop.outcome}`}`]
    // A list states its join under its last phase, which holds the join.
    const joined = node.kind === "phase" && (node.list === undefined ? node.join !== undefined : lastPhases.get(node.list.id) === node.id)
    if (node.kind !== "phase" || !joined) return [line]
    const settled = joins.get(node.list?.id ?? node.id)
    const joinText = [...joinLines(node.join, node.round), ...(settled === undefined ? [] : [...coverageLines(settled), ...selectionLines(settled)])]
    return [line, ...joinText.map((joinLine) => `${indent}  ${joinLine}`)]
  })
}

/** A list's join in words: its reducer, whether it settled, and where each
 *  slot stands. Every slot is named, so the counts add up to the item
 *  count, and a list with no items reads as zero targets. The join of one
 *  round of a repeat names its round and, once the repeat decided, where
 *  the repeat went, such as `Join dedupe@2 of round 2 → dry`. */
function joinLines(join: WorkflowTreeJoin | undefined, round: WorkflowTreePhase["round"]): readonly string[] {
  const of = round === undefined ? "" : ` of round ${round.number}${roundTarget(round) ?? ""}`
  if (join === undefined) return [`Join${of}: waits for the list's items`]
  if (join.slots === 0) return [`Join ${join.reducer}${of}: ${join.state}, 0 targets`]
  const counts = [`${join.completed} completed`, `${join.failed} failed`, `${join.pending} not finished`, ...(join.missing > 0 ? [`${join.missing} missing`] : [])]
  return [`Join ${join.reducer}${of}: ${join.state}, ${join.slots} items: ${counts.join(", ")}`]
}

/** What one `group.settled` fact records: the reducer that folded the join
 *  and the output that it wrote, with the output contract that the group
 *  pins in control. */
interface SettledJoin {
  readonly reducer: { readonly id: string; readonly version: number }
  readonly output: ReducerOutput
  readonly contract: FieldMap
}

/** The join that each group's `group.settled` fact records, by group id, so
 *  inspection reports what the run recorded and folds nothing again. A
 *  group settles again after a Resume reruns one of its items, and its
 *  latest settlement is the one that holds. */
function settledJoins(facts: readonly StoredFact[], control: CommittedWorkflowControl): ReadonlyMap<string, SettledJoin> {
  const contracts = new Map(control.graph.nodes.flatMap((node) => node.kind === "list" ? [[node.id, node.reducer.contract] as const]
    : node.kind === "phase" && node.join !== null ? [[node.id, node.join.reducer.contract] as const] : []))
  const joins = new Map<string, SettledJoin>()
  for (const { type, version, actor, payload } of facts) {
    if (type !== "group.settled") continue
    const fact = parseWorkflowSessionFact({ type, version, actor, payload })
    if (fact.type !== "group.settled") continue
    const contract = contracts.get(fact.payload.groupNodeId)
    if (contract !== undefined) joins.set(fact.payload.groupNodeId, { reducer: fact.payload.reducer, output: fact.payload.output, contract })
  }
  return joins
}

/** What a selecting join kept and dropped, from the output that its
 *  `group.settled` fact records: its words as the clients show them, then
 *  each kept entry, each dropped entry with its reason, and the failed
 *  agents. A join whose reducer selects nothing has no lines. */
function selectionLines({ reducer, output, contract }: SettledJoin): readonly string[] {
  const selection = requireReducer(reducer.id, reducer.version).selection?.(output, contract)
  if (selection === undefined) return []
  const entry = ({ key, branch, reason }: SelectionEntry): string =>
    `    ${key ?? "(no key)"}${branch === undefined ? "" : ` from ${branch}`}${reason === undefined ? "" : `: ${reason}`}`
  const list = (name: string, entries: readonly SelectionEntry[]): readonly string[] =>
    entries.length === 0 ? [`  ${name}: none`] : [`  ${name}:`, ...entries.map(entry)]
  const [keptName, droppedName] = selection.verb === "passed" ? ["Passed", "Rejected"] : ["Kept", "Dropped"]
  return [
    `Selection: ${selectionText({ verb: selection.verb, kept: selection.kept.length, dropped: selection.dropped.length })}`,
    ...list(keptName, selection.kept),
    ...list(droppedName, selection.dropped),
    `  Failed: ${selection.failed.length === 0 ? "none" : selection.failed.join(", ")}`,
  ]
}

/** The coverage of a folded coverage join, from the output that its
 *  `group.settled` fact records: its words as the clients show them, then
 *  each tier's exact numerator and denominator with the keys it did not
 *  reach, and the inaccessible, excluded, and failed keys. A join whose
 *  reducer reports no coverage has no lines. */
function coverageLines({ reducer, output }: SettledJoin): readonly string[] {
  const coverage = requireReducer(reducer.id, reducer.version).coverage?.(output)
  if (coverage === undefined) return []
  const survey = Schema.decodeUnknownSync(CoverageOutputSchema)(output)
  const keys = (list: readonly string[]): string => list.length === 0 ? "none" : list.join(", ")
  const tier = (name: string, { numerator, denominator, unsurveyed }: typeof survey.required): string =>
    `  ${name}: ${numerator} of ${denominator} surveyed; unsurveyed: ${keys(unsurveyed)}`
  return [
    `Coverage: ${coverage.status}, ${coverageText(coverage)}`,
    tier("Required", survey.required),
    tier("Supporting", survey.supporting),
    `  Inaccessible: ${keys(survey.inaccessible)}`,
    `  Excluded: ${keys(survey.excluded)}`,
    `  Failed: ${keys(survey.failed)}`,
  ]
}

function contextExclusionLines(facts: readonly StoredFact[]): readonly string[] {
  try {
    const { exclusions } = loadAccumulatedContextFromEvents(facts)
    return exclusions.length === 0
      ? ["Context exclusions: none"]
      : ["Context exclusions:", ...exclusions.map((exclusion) => `- ${exclusion.kind} ${exclusion.id}: ${exclusion.reason}${exclusion.kind === "join_reference" ? `, item ${JSON.stringify(exclusion.key)} withholds ${exclusion.bytes} bytes; join ${exclusion.join} shows ${exclusion.shownBytes} bytes` : ""}`)]
  } catch (error) {
    return [`Context exclusions: unreadable. ${errorMessage(error)}`]
  }
}

/** Read one workflow aggregate from the project's store through a
 *  read-only connection. It opens no workspace state and runs no migration,
 *  because either one can write. */
function readWorkflowRunFacts(workflowId: string, directories: ProjectDirectories): (StoredFact | CorruptEventRowError)[] {
  const reader = openReadonlyEventReader(resolveEventStoreDbFile(directories.projectRoot))
  try {
    return reader.readTolerant({ aggregateId: workflowAggregateId(workflowId) })
  } finally {
    reader.close()
  }
}

export async function runWorkflowVerify(args: readonly string[], directories: ProjectDirectories): Promise<0 | 1 | 2> {
  if (args[0] === "--workflow") {
    const workflowId = args[1]
    if (args.length !== 2 || !workflowId) {
      console.error("workflow verify --workflow accepts exactly one workflow id.")
      console.error(usage())
      return 2
    }
    try {
      const verification = verifyWorkflowRun(workflowId, readWorkflowRunFacts(workflowId, directories))
      console.log(verification.text)
      return verification.sound ? 0 : 1
    } catch (error) {
      console.error(errorMessage(error))
      return 2
    }
  }
  if (args.length !== 1) {
    console.error("workflow verify accepts exactly one workflow id or file path.")
    console.error(usage())
    return 2
  }

  const input = args[0]
  if (!input) {
    console.error("workflow verify accepts exactly one workflow id or file path.")
    console.error(usage())
    return 2
  }

  let prepared: ReturnType<typeof prepareWorkspaceState> | undefined
  try {
    prepared = prepareWorkspaceState(directories)
    const report = await resolveWorkflowVerifyInput(input, projectDependencies(directories))
    console.log(renderWorkflowVerificationReport(report))
    return report.result === "invalid" ? 1 : 0
  } catch (error) {
    console.error(errorMessage(error))
    console.error(usage())
    return 2
  } finally {
    prepared?.generation.release()
  }
}

function usage(): string {
  return "Usage: flywheel workflow verify <workflow.yaml|workflow.json> | flywheel workflow verify --workflow <workflow-id>"
}
