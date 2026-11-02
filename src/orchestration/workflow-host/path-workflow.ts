/** The path source of the `workflow` tool: a workflow file in the session
 *  scratch directory that a chat agent wrote, or that the tool saved from
 *  the content of a call or copied from a file the call named elsewhere,
 *  launched by path (ARCH-WORKFLOWS-009).
 *
 *  The file is untrusted input. One guarded pipeline reads it once, decodes
 *  it strictly, keeps it self-contained, keeps each agent within the tools and
 *  personas of the launching session, and runs the production verifier, all
 *  before any approval is consumed or any fact is written. The pipeline
 *  refuses only a file that cannot run, such as one that does not parse,
 *  because the author learns more from a run than from a refusal; everything else that it finds, such as a retired key
 *  or what the verifier did not prove, is a warning that the launch reports.
 *  Each refusal and each warning names the file by its path in the session
 *  directory, the phase, agent, or repeat, and the schema key path at fault, and a
 *  refusal points the author at the `workflow-authoring` skill. */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { ContainedDirectory, ContainedFileTooLargeError, ContainedPathError } from "../../infra/descriptor-directory.js"
import { DebugLog } from "../../infra/debug-log.js"
import { errnoCode, errorMessage } from "../../infra/error-message.js"
import { sessionScratchDir } from "../../infra/paths.js"
import { WORKFLOW_FILE_EXTENSION, workflowContentFileName, type WorkflowCallSource } from "../../infra/tools/workflow-call-source.js"
import type { ToolAction } from "../../infra/workflow-types.js"
import type { DefinitionAssetReader } from "../../workflows/definition-assets.js"
import { hashDefinition } from "../../workflows/definition-hash.js"
import { canonicalWorkflowRecord } from "../../workflows/definition-records.js"
import type { ProjectDefinitionRegistryRevision } from "../../workflows/definition-registry.js"
import { resolveToolPath } from "../agent-runtime/tools/tool-paths.js"
import { resolveWorkflowAgents, type ResolvedAgent } from "../../workflows/agent-resolution.js"
import { canonicalStepWorkflowRecord } from "../../workflows/retired-step-grammar/records.js"
import { stepGrammarWarning } from "../../workflows/retired-step-grammar/convert.js"
import { verifyAuthoredWorkflow } from "../../workflows/vm/verify.js"
import { structuralRemedy, type WorkflowStructureRejectedError } from "../../workflows/vm/structural-admission.js"
import { launchVerificationWarnings, type WorkflowVerificationReport } from "../../workflows/vm/verify-types.js"
import {
  decodeWorkflowFile,
  loadDecodedWorkflow,
  renderWorkflowFileDiagnostic,
  workflowDiagnosticText,
  workflowPhaseLocations,
  type AuthoredWorkflowDefinition,
  type WorkflowFileDiagnostic,
} from "../../workflows/workflow-file.js"
import { WORKFLOW_FILE_MAX_BYTES } from "../../infra/workflow-yaml.js"
import { agentLabel, agentRecords, DEFAULT_COUNTED_LIST_MAX, dotFreeSlugIssue, namedAgents, phaseLabel, walkPhases, type AgentRecordKeys, type WorkflowDefinition } from "../../workflows/workflow-schema.js"
import type { WorkflowDefinitionRefusal, WorkflowDefinitionResolution } from "./workflow-admission.js"

/** What a workflow file may grant an agent: the tools and personas of the
 *  session that launches it. The host derives it from the tools that the
 *  session's runner planned, never from model input. */
export interface LaunchingSessionAuthority {
  readonly toolActions: ReadonlySet<ToolAction>
  readonly personas: ReadonlySet<string>
}

/** The one directory a session's workflow files launch from. */
export function sessionWorkflowsDir(sessionDir: string): string {
  return join(sessionScratchDir(sessionDir), "workflows")
}

/** Save the content of a workflow file that a `workflow` call or an
 *  approval question passes, and answer the file's absolute path. The file
 *  is `<id>.workflow.yaml` in the workflow directory (refer to
 *  `workflowContentFileName`) and replaces a file of that name, so an
 *  author revises a workflow by sending it again. A run never reads its
 *  file again, so a replaced file never changes a run that started. The
 *  content over the byte limit is refused before parsing or writing. Other launch
 *  checks follow the save, so a refused launch keeps the file for the
 *  author to fix. The write is atomic and follows no directory link. */
export function saveWorkflowContent(sessionDir: string, content: string): string {
  const bytes = Buffer.byteLength(content)
  if (bytes > WORKFLOW_FILE_MAX_BYTES) throw new Error(`the workflow content holds ${bytes} bytes, more than the limit of ${WORKFLOW_FILE_MAX_BYTES}`)
  const name = workflowContentFileName(content)
  const directory = ContainedDirectory.open(sessionDir, relative(sessionDir, sessionWorkflowsDir(sessionDir)).split(sep), { noFollowBase: true })
  try {
    const file = join(directory.canonicalPath(), name)
    const replaced = directory.hasEntry(name)
    const failure = directory.publishFileThrough(`.workflow-write.${process.pid}.${randomBytes(6).toString("hex")}`, name, content)
    if (failure) throw failure
    DebugLog.record({
      type: "workflow.file.saved",
      payload: { file, bytes, sha256: createHash("sha256").update(content).digest("hex"), replaced },
    })
    return file
  } finally {
    directory.close()
  }
}

/** The file that one `workflow` call launches, and the bytes it judges. */
export interface StagedWorkflowFile {
  /** The absolute path of the file in the session's workflow directory. */
  readonly path: string
  /** Bytes the call saved there; absent when the call names a file that was already there. */
  readonly savedContent?: string
  /** The file that a path call named outside the workflow directory, whose bytes the call saved. */
  readonly copiedFrom?: string
}

/** Place what one `workflow` call names in the session's workflow
 *  directory, so every file that runs is a file there. Content is saved as
 *  its own file. A path resolves as a file tool resolves it: an absolute
 *  path as written, and a relative path from the agent's working directory,
 *  then from the session directory, where `scratch/workflows/<name>` names a
 *  saved file. A file inside the workflow directory launches as it is. A
 *  file anywhere else, such as one in the project, is read once and saved
 *  as content, so a file can launch from any path; a later edit of the
 *  original never changes the run. */
export function stageWorkflowSource(source: WorkflowCallSource, sessionDir: string, executionCwd: string): StagedWorkflowFile | { readonly error: string } {
  if (source.kind === "content") return { path: saveWorkflowContent(sessionDir, source.content), savedContent: source.content }
  const fromCwd = isAbsolute(source.path) ? resolve(source.path) : resolveToolPath(executionCwd, source.path)
  const named = isAbsolute(source.path) || existsSync(fromCwd) ? fromCwd : resolve(sessionDir, source.path)
  if (inside(sessionWorkflowsDir(sessionDir), named)) return { path: named }
  if (!named.endsWith(WORKFLOW_FILE_EXTENSION)) return { error: `The workflow file ${named} cannot launch: its name must end in ${WORKFLOW_FILE_EXTENSION}.` }
  let content: string
  try {
    const stat = statSync(named)
    if (!stat.isFile()) return { error: `The workflow file ${named} cannot launch: it is not a file.` }
    if (stat.size > WORKFLOW_FILE_MAX_BYTES) return { error: `The workflow file ${named} cannot launch: it holds more than the limit of ${WORKFLOW_FILE_MAX_BYTES} bytes.` }
    content = readFileSync(named, "utf8")
  } catch (error) {
    return { error: errnoCode(error) === "ENOENT" ? `No workflow file exists at ${named}.` : `The workflow file ${named} cannot be read: ${errorMessage(error)}` }
  }
  return { path: saveWorkflowContent(sessionDir, content), savedContent: content, copiedFrom: named }
}

/** One workflow file read and judged as a definition. */
export interface PathWorkflow {
  readonly workflow: WorkflowDefinition
  /** The real path of the file, which its run records as provenance. */
  readonly file: string
  /** The file as a diagnostic names it: its path in the session directory. */
  readonly shown: string
  /** The canonical definition hash: the hash the run records, and the hash
   *  an Ask approval of this file binds. */
  readonly definitionSha256: string
  /** For a file in the retired step grammar, the canonical hash of its
   *  retired step-grammar record, which an Ask approval asked before phases bound.
   *  Remove after 2027-04-30. */
  readonly retiredDefinitionSha256?: string
}

/** A workflow file that may launch, with the verifier's report of it and
 *  what the launch warns about: each problem that does not stop the file
 *  from running, located as a refusal locates a problem. */
export interface PathWorkflowLaunch extends PathWorkflow {
  readonly verification: WorkflowVerificationReport
  readonly warnings: readonly WorkflowFileDiagnostic[]
}

/** What the author of a refused workflow file does next. Every refusal of
 *  the path pipeline ends with it, so the author always learns where the
 *  file format is documented. */
export const WORKFLOW_FILE_RECOVERY = "Load the `workflow-authoring` skill if you have not, fix the file, and launch it again."

/** Whether `candidate` is below `root`. */
function inside(root: string, candidate: string): boolean {
  const rest = relative(root, candidate)
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}

/** How a refusal names a path: relative to the session directory with
 *  forward slashes, as the agent wrote it, such as
 *  `scratch/workflows/review.workflow.yaml`. A path outside the session
 *  directory keeps its absolute form. */
function shownPath(sessionDir: string, path: string): string {
  return inside(sessionDir, path) ? relative(sessionDir, path).split(sep).join("/") : path
}

/** How a refusal names the workflow file that `path` names, so the
 *  sentence that heads a refusal and its located problems name the file in
 *  one form, whether the agent passed a relative or an absolute path. */
export function workflowFileName(path: string, sessionDir: string): string {
  return shownPath(sessionDir, isAbsolute(path) ? resolve(path) : resolve(sessionDir, path))
}

/** The file that one named path resolves to, or why it cannot launch. A
 *  relative path resolves from the session directory, so
 *  `scratch/workflows/<name>.workflow.yaml` names the file there. `shown` is
 *  how a diagnostic names the file. A refusal of the path names the workflow
 *  directory by its absolute path, because a file tool resolves a relative
 *  path from the project directory first, so an author who wrote
 *  `scratch/workflows/<name>.workflow.yaml` may have written it there. */
function resolveWorkflowFile(path: string, sessionDir: string, savedContent?: string): { readonly ok: true; readonly file: string; readonly shown: string; readonly content: string } | { readonly ok: false; readonly reason: string } {
  const named = isAbsolute(path) ? resolve(path) : resolve(sessionDir, path)
  if (!named.endsWith(WORKFLOW_FILE_EXTENSION)) return { ok: false, reason: `its name must end in ${WORKFLOW_FILE_EXTENSION}` }
  const dir = sessionWorkflowsDir(sessionDir)
  const shown = shownPath(sessionDir, named)
  if (!inside(dir, named)) return { ok: false, reason: `${shown} is not in this session's workflow directory ${dir}` }
  const missing = `no file exists at ${shown}; write it in this session's workflow directory ${dir}`
  let directory: ContainedDirectory | undefined
  try {
    directory = ContainedDirectory.openExisting(sessionDir, relative(sessionDir, dirname(named)).split(sep), { noFollowBase: true })
    if (!directory) return { ok: false, reason: missing }
    const file = join(directory.canonicalPath(), basename(named))
    if (savedContent !== undefined) return { ok: true, file, shown, content: savedContent }
    const bytes = directory.readFile(basename(named), WORKFLOW_FILE_MAX_BYTES)
    if (!bytes) return { ok: false, reason: missing }
    return { ok: true, file, shown, content: bytes.toString("utf8") }
  } catch (error) {
    if (error instanceof ContainedFileTooLargeError) return { ok: false, reason: `${shown} holds more than the limit of ${WORKFLOW_FILE_MAX_BYTES} bytes` }
    if (error instanceof ContainedPathError) {
      // The POSIX backend opens a directory and then finds it is not a regular
      // file; the Windows backend refuses to open a directory as a file (EISDIR).
      return { ok: false, reason: errnoCode(error) === "EISDIR" || error.message.includes("not a regular file")
        ? `${shown} is not a file`
        : `${shown} names a link or non-directory, which is outside this session's workflow directory ${dir}` }
    }
    return { ok: false, reason: `${shown} cannot be read: ${errorMessage(error)}` }
  } finally {
    directory?.close()
  }
}

/** Problems that make a decoded file depend on a contract outside itself.
 *  Brief loading refuses a `runs` name that this file does not hold. */
function selfContainmentDiagnostics(file: string, definition: AuthoredWorkflowDefinition): WorkflowFileDiagnostic[] {
  const diagnostics: WorkflowFileDiagnostic[] = []
  const at = (keyPath: string, message: string, entry?: string): void => { diagnostics.push({ file, ...(entry === undefined ? {} : { entry }), keyPath, message }) }
  const slugIssue = dotFreeSlugIssue(definition.id)
  if (slugIssue !== undefined) at("id", `${slugIssue}; give the file its own id`)
  if (typeof definition.input === "string") at("input", `${JSON.stringify(definition.input)} names a contract file; write the input contract inline`)
  const record = (keyPath: string, entry: string, keys: AgentRecordKeys): void => {
    if (typeof keys.output === "string") at(`${keyPath}.output`, `${JSON.stringify(keys.output)} names a contract file; write the output contract inline`, entry)
  }
  walkPhases(definition.phases, (phase, location) => {
    const keyPath = location.repeat === undefined ? `phases.${location.topIndex}` : `phases.${location.topIndex}.phases.${location.index}`
    record(keyPath, phaseLabel(phase.phase), phase)
    for (const [index, agent] of namedAgents(phase).entries()) record(`${keyPath}.agents.${index}`, agentLabel(agent.agent), agent)
  })
  return diagnostics
}

/** A warning at each counted list of an agent's output that declares no
 *  `max` and that the loader held to {@link DEFAULT_COUNTED_LIST_MAX},
 *  located where the agent's record declares its output: the inline list,
 *  the contract reference, or the brief that it runs. */
function countedListWarnings(file: string, workflow: WorkflowDefinition): WorkflowFileDiagnostic[] {
  const locations = workflowPhaseLocations(workflow)
  const records = agentRecords(workflow)
  return [...workflow.briefs ?? []].flatMap(([definitionId, brief]) => brief.defaultedLists.map((field) => {
    const place = locations.byRecord.get(definitionId)
    const keys = records.get(definitionId)?.keys
    const at = place?.keyPath ?? "phases"
    const keyPath = typeof keys?.output === "object" ? `${at}.output.fields.${field}`
      : keys?.output !== undefined ? `${at}.output`
      : keys?.runs !== undefined ? `${at}.runs` : at
    return {
      file,
      ...(place === undefined ? {} : { entry: place.label }),
      keyPath,
      message: `a phase over a list, a repeat, or a join counts the list "${field}", which declares no max, so the agent may report at most ${DEFAULT_COUNTED_LIST_MAX} items; declare max to change it`,
    }
  }))
}

/** One workflow file read once and judged as a definition, with every
 *  problem that the checks found. `workflow` is the definition when content
 *  loading and semantic validation accepted it, and `loaded` is the
 *  definition whose content loaded, valid or not. */
interface PathWorkflowRead {
  readonly ok: true
  readonly file: string
  readonly shown: string
  readonly diagnostics: readonly WorkflowFileDiagnostic[]
  /** What the checks found that does not stop the file from running. */
  readonly warnings: readonly WorkflowFileDiagnostic[]
  readonly loaded?: WorkflowDefinition
  readonly workflow?: WorkflowDefinition
}

/** Read one workflow file once and judge it: the path rules, strict
 *  decoding, the retired keys, the default `max` of a counted output list,
 *  self-containment, the slug and collision rules, content loading, and
 *  semantic validation with structural admission. A path that cannot be
 *  read refuses at once. A malformed shape stops the later checks, but
 *  excess keys leave a definition to judge without those keys. The later
 *  checks are independent, so each reports what it found. */
async function judgePathWorkflow(path: string, sessionDir: string, revision: ProjectDefinitionRegistryRevision, reader: DefinitionAssetReader | undefined, savedContent?: string): Promise<PathWorkflowRead | WorkflowDefinitionRefusal> {
  const resolved = resolveWorkflowFile(path, sessionDir, savedContent)
  if (!resolved.ok) return { ...resolved, recovery: WORKFLOW_FILE_RECOVERY }
  const { file, shown, content } = resolved
  const result = decodeWorkflowFile({ file: shown, content, skills: revision.skills, retiredBindings: "refuse" })
  const diagnostics = result.ok ? [] : result.diagnostics
  const decoded = result.ok ? result : result.recovered
  if (!decoded) return { ok: true, file, shown, diagnostics, warnings: [] }
  // The retired step grammar converts as a pure function of the file's text, so a
  // run rebuilds it from its record, and the file runs with a warning.
  const converted = decoded.stepGrammar === undefined ? [] : [{ file: shown, keyPath: "(root)", message: stepGrammarWarning(decoded.stepGrammar.notes) }]
  // A saved file keeps loading with a retired key, which means nothing now.
  // A launched file is new, so a retired key in it is an author's mistake,
  // but the loader drops it, so the file runs.
  const retired = decoded.retiredKeys.map((keyPath) => ({ file: shown, keyPath, message: "this key is retired and does nothing; remove it" }))
  // A mistake with one reading runs as that reading, and its warning tells
  // the author what the file must say.
  const repaired = decoded.repairs.map(({ keyPath, message }) => ({ file: shown, keyPath, message }))
  const contained = selfContainmentDiagnostics(shown, decoded.definition)
  // A file reference cannot load without its file, so content loading and
  // semantic validation judge only a file whose content is all inline. A
  // retired key or an id problem does not stop them.
  const loaded = contained.some(({ keyPath }) => keyPath !== "id") ? undefined : loadDecodedWorkflow({
    file: shown,
    decoded,
    location: undefined,
    provenance: { layer: "session", filePath: file, id: decoded.definition.id },
    skills: revision.skills,
    ...(reader ? { reader } : {}),
  })
  return {
    ok: true,
    file,
    shown,
    diagnostics: [...diagnostics, ...contained, ...(loaded?.ok === false ? loaded.diagnostics : [])],
    warnings: [...converted, ...retired, ...repaired, ...(loaded?.ok === true ? countedListWarnings(shown, loaded.workflow) : [])],
    ...(loaded?.ok === true ? { loaded: loaded.workflow, workflow: loaded.workflow } : loaded?.loaded ? { loaded: loaded.loaded } : {}),
  }
}

/** The reason of a refusal whose file has located problems of its own. */
const INVALID_FILE = "the file is not valid"

/** Judge saved content, or read one workflow file once, as a definition. An Ask
 *  approval judges the bytes here, so the question and the launch bind the
 *  same definition hash. A refusal reports every problem that the checks
 *  found, so the author can fix them in one edit. */
export async function readPathWorkflow(input: {
  readonly path: string
  /** Bytes already saved by the content call; a path call reads the file instead. */
  readonly savedContent?: string
  readonly sessionDir: string
  readonly revision: ProjectDefinitionRegistryRevision
  readonly reader?: DefinitionAssetReader
}): Promise<WorkflowDefinitionResolution<PathWorkflow>> {
  const read = await judgePathWorkflow(input.path, input.sessionDir, input.revision, input.reader, input.savedContent)
  if (!read.ok) return read
  return valid(read) ?? { ok: false, reason: INVALID_FILE, diagnostics: read.diagnostics, recovery: WORKFLOW_FILE_RECOVERY }
}

/** The definition of a judged file that has no problem, or nothing. */
function valid(read: PathWorkflowRead): PathWorkflow & { readonly ok: true } | undefined {
  const { workflow, file, shown } = read
  if (workflow === undefined || read.diagnostics.length > 0) return undefined
  const retired = workflow.retiredStepGrammar?.workflow
  return {
    ok: true,
    workflow,
    file,
    shown,
    definitionSha256: hashDefinition(canonicalWorkflowRecord(workflow)).sha256,
    ...(retired === undefined ? {} : { retiredDefinitionSha256: hashDefinition(canonicalStepWorkflowRecord(retired)).sha256 }),
  }
}

/** The whole path pipeline before approval: judge saved content or read the file, keep each agent
 *  within the tools and personas of the launching session, and run the
 *  production verifier. It refuses only a file that cannot run: a problem
 *  of the file itself, or an agent that asks for more than the launching
 *  session holds. The checks after strict decoding are independent, so one
 *  refusal reports what each found: the authority check judges every file
 *  whose content loaded. The verifier judges every file that semantic
 *  validation accepted, and what it leaves unproved is a warning of the
 *  launch, beside the warnings of the read. */
export async function loadPathWorkflow(input: {
  readonly path: string
  /** Bytes already saved by the content call; a path call reads the file instead. */
  readonly savedContent?: string
  readonly sessionDir: string
  readonly revision: ProjectDefinitionRegistryRevision
  readonly authority: LaunchingSessionAuthority
}): Promise<WorkflowDefinitionResolution<PathWorkflowLaunch>> {
  const { revision } = input
  const read = await judgePathWorkflow(input.path, input.sessionDir, revision, undefined, input.savedContent)
  if (!read.ok) return read
  const agents = read.loaded === undefined ? undefined : resolveWorkflowAgents(read.loaded)
  const escalations = agents === undefined || read.loaded === undefined ? [] : authorityDiagnostics(read.shown, read.loaded, agents.values(), input.authority)
  const reasons = [
    ...(read.diagnostics.length > 0 ? [INVALID_FILE] : []),
    ...(escalations.length > 0 ? ["its agents ask for more than the launching session holds"] : []),
  ]
  const accepted = valid(read)
  if (reasons.length > 0 || accepted === undefined || agents === undefined) {
    return { ok: false, reason: reasons.join(", and ") || INVALID_FILE, diagnostics: [...read.diagnostics, ...escalations], recovery: WORKFLOW_FILE_RECOVERY }
  }
  const verification = verifyAuthoredWorkflow(accepted.workflow, agents, { skills: revision.skills, personas: revision.personas })
  return { ...accepted, verification, warnings: [...read.warnings, ...verificationWarnings(read.shown, accepted.workflow, verification)] }
}

/** The tool actions that every workflow agent holds. Every agent gets the
 *  worker's whole tool set (ARCH-CONTEXT-018), so a session that lacks one of these
 *  cannot launch a workflow file: its agents would act beyond it. An agent
 *  dispatches the personas of its `subagents`, which the persona check
 *  bounds, and the trial advisor default, which stays outside the check
 *  (refer to `workflowAgentSubagents`). It runs as its `persona`, which the
 *  persona check also bounds, so the subagent tool is not one of these. */
const AGENT_TOOL_ACTIONS: readonly ToolAction[] = ["file_read", "shell_exec", "search", "list", "file_write", "file_edit"]

/** The tools that the launching session lacks and every agent would hold,
 *  and the agents that run as or dispatch a persona that the session cannot
 *  dispatch. */
function authorityDiagnostics(file: string, workflow: WorkflowDefinition, agents: Iterable<ResolvedAgent>, authority: LaunchingSessionAuthority): WorkflowFileDiagnostic[] {
  const diagnostics: WorkflowFileDiagnostic[] = []
  const missing = AGENT_TOOL_ACTIONS.filter((action) => !authority.toolActions.has(action))
  if (missing.length > 0) {
    diagnostics.push({ file, keyPath: "(root)", message: `every agent gets the tools ${missing.join(", ")}, which the launching session does not have` })
  }
  const locations = workflowPhaseLocations(workflow)
  const records = agentRecords(workflow)
  for (const agent of agents) {
    const place = locations.byRecord.get(agent.definitionId)
    const at = place?.keyPath ?? "phases"
    const entry = place === undefined ? {} : { entry: place.label }
    const keys = records.get(agent.definitionId)?.keys
    const unknown = agent.subagents.filter((persona) => !authority.personas.has(persona))
    if (unknown.length > 0) {
      diagnostics.push({ file, ...entry, keyPath: keys?.subagents === undefined ? at : `${at}.subagents`, message: `names ${unknown.join(", ")}, which the launching session cannot dispatch` })
    }
    if (agent.persona !== undefined && !authority.personas.has(agent.persona)) {
      diagnostics.push({ file, ...entry, keyPath: `${at}.persona`, message: `runs as persona ${agent.persona}, which the launching session cannot dispatch` })
    }
  }
  return diagnostics
}

/** Where a finding about the compiled node `target` sits in the file: the
 *  phase, agent, or repeat whose node is the target or holds it, or the
 *  whole list of phases. */
function targetLocator(workflow: WorkflowDefinition): (target: string | null) => Pick<WorkflowFileDiagnostic, "entry" | "keyPath"> {
  const locations = workflowPhaseLocations(workflow)
  return (target) => {
    let best: { readonly id: string; readonly label: string; readonly keyPath: string } | undefined
    for (const [id, location] of locations.byNodeId) {
      if (target !== null && (target === id || target.startsWith(`${id}:`)) && (best === undefined || id.length > best.id.length)) best = { id, ...location }
    }
    return best ? { entry: best.label, keyPath: best.keyPath } : { keyPath: "phases" }
  }
}

/** What a verifier report leaves unproved, each located at the phase,
 *  agent, or repeat that it targets: each defect, and each uncertainty that the values of a
 *  run do not decide (refer to `launchVerificationWarnings`). */
export function verificationWarnings(file: string, workflow: WorkflowDefinition, verification: WorkflowVerificationReport): WorkflowFileDiagnostic[] {
  const warned = launchVerificationWarnings(verification)
  const located = targetLocator(workflow)
  return [
    ...warned.findings.map((finding) => ({ file, ...located(finding.target), message: `${finding.name}: ${finding.message}` })),
    ...warned.uncertainties.map((uncertainty) => ({ file, ...located(uncertainty.target), message: `${uncertainty.name}: ${uncertainty.detail}` })),
  ]
}

/** The warnings of one launched file as the lines that its run records, that
 *  the launch result shows beside the file, and that the parent chat's
 *  workflow card shows without it. */
export function launchWarningLines(file: Pick<PathWorkflowLaunch, "warnings">): readonly string[] {
  return file.warnings.map(workflowDiagnosticText)
}

/** The refusal of a read file that structural admission refused at launch.
 *  The pipeline before approval counts a sample of the launch input against
 *  the declared `max_attempts`, or its worst case against the ceiling when the
 *  file declares none, so only the launch, with the real input, finds a
 *  workflow too large for this launch. Each finding is located as a verifier finding
 *  is. */
export function launchStructureRefusal(read: PathWorkflow, error: WorkflowStructureRejectedError): WorkflowDefinitionRefusal {
  const located = targetLocator(read.workflow)
  return {
    ok: false,
    reason: "structural admission refused its phases for this launch",
    diagnostics: error.findings.map(({ name, target, message }) => ({ file: read.shown, ...located(target), message: `${name}: ${message} ${structuralRemedy(name)}` })),
    recovery: WORKFLOW_FILE_RECOVERY,
  }
}

/** One refusal as its reason after `lead` and each located problem of
 *  the file. The model reads both; the workflow card shows the person the
 *  reason and how many problems the agent has to fix. The recovery of a
 *  refusal is not part of it, because it speaks to the agent. */
export function describeDefinitionRefusal(lead: string, refusal: WorkflowDefinitionRefusal) {
  return { error: `${lead}${refusal.reason}.`, problems: refusal.diagnostics?.map(renderWorkflowFileDiagnostic) ?? [] }
}

