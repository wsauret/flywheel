import { Result, Schema, SchemaIssue } from "effect";
import * as yaml from "js-yaml";
import { errorMessage } from "../infra/error-message.js";
import { definitionAssets, type AssetLocation, type DefinitionAssetReader } from "./definition-assets.js";
import type { DefinitionProvenance } from "./definition-provenance.js";
import { validateWorkflowDefinition } from "./definition-validation.js";
import { normalizeAuthoredDocument, withLoadedContent, type NormalizedAuthoredDocument } from "./loader.js";
import { parseWorkflowYaml, UnsupportedWorkflowYamlError } from "../infra/workflow-yaml.js";
import type { AuthoredRepair } from "./authored-repairs.js";
import type { SkillRegistryRevision } from "./skill-schema.js";
import {
  agentLabel,
  authoredPhaseOrRepeatKind,
  isRepeat,
  namedAgentNodeId,
  namedAgents,
  PHASE_OR_REPEAT_SCHEMAS,
  phaseLabel,
  phaseNodeId,
  repeatLabel,
  streams,
  topNodeId,
  walkPhases,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowPhase,
} from "./workflow-schema.js";
import type { StepGrammarConversion } from "./retired-step-grammar/convert.js";

/** One problem with one workflow file, located for its author: the file,
 *  the label of the phase, agent, or repeat at fault when one is, and the
 *  schema key path, such as `phases.1.output`. A diagnostic carries no line
 *  and no column: the author fixes the key that it names. */
export interface WorkflowFileDiagnostic {
  readonly file: string;
  readonly entry?: string;
  readonly keyPath: string;
  readonly message: string;
}

/** The authored definition of one file, decoded strictly. */
export type AuthoredWorkflowDefinition = typeof WorkflowDefinitionSchema.Type;

/** One diagnostic without its file: the phase, agent, or repeat, the key
 *  path, and the message. */
export function workflowDiagnosticText(diagnostic: Omit<WorkflowFileDiagnostic, "file">): string {
  return `${diagnostic.entry === undefined ? "" : `${diagnostic.entry}, `}${diagnostic.keyPath}: ${diagnostic.message}`;
}

/** One diagnostic as one line of text. */
export function renderWorkflowFileDiagnostic(diagnostic: WorkflowFileDiagnostic): string {
  return `${diagnostic.file}: ${workflowDiagnosticText(diagnostic)}`;
}

type DocumentNode = { readonly [key: string]: unknown };

function isNode(value: unknown): value is DocumentNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The label of the phase, named agent, or repeat that a key path points
 *  into, read from the parsed document, or undefined when the path is
 *  outside `phases`. */
function entryAt(document: unknown, segments: readonly (string | number)[]): string | undefined {
  const top = isNode(document) && Array.isArray(document.phases) ? document.phases : undefined;
  const topIndex = segments[0] === "phases" ? segments[1] : undefined;
  if (top === undefined || typeof topIndex !== "number") return undefined;
  let entry: unknown = top[topIndex];
  let rest = segments.slice(2);
  if (!isNode(entry)) return undefined;
  if (Array.isArray(entry.phases)) {
    const index = rest[0] === "phases" ? rest[1] : undefined;
    if (typeof index !== "number") return repeatLabel(topIndex);
    entry = entry.phases[index];
    rest = rest.slice(2);
    if (!isNode(entry)) return repeatLabel(topIndex);
  }
  const agentIndex = rest[0] === "agents" ? rest[1] : undefined;
  const agents = entry.agents;
  if (typeof agentIndex === "number" && Array.isArray(agents) && isNode(agents[agentIndex]) && typeof agents[agentIndex].agent === "string") {
    return agentLabel(agents[agentIndex].agent);
  }
  return typeof entry.phase === "string" ? phaseLabel(entry.phase) : undefined;
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function issueDiagnostics(file: string, document: unknown, issue: SchemaIssue.Issue, prefix: readonly (string | number)[] = []): readonly WorkflowFileDiagnostic[] {
  return formatIssues(issue).issues.map(({ path, message }) => {
    const segments = [...prefix, ...(path ?? []).map((segment) => {
      const key = typeof segment === "object" ? segment.key : segment;
      return typeof key === "number" ? key : String(key);
    })];
    const entry = entryAt(document, segments);
    return {
      file,
      ...(entry === undefined ? {} : { entry }),
      keyPath: segments.length === 0 ? "(root)" : segments.join("."),
      message,
    };
  });
}

const decodeStrictly = <S extends Schema.Decoder<unknown>>(schema: S) => Schema.decodeUnknownResult(schema, { onExcessProperty: "error", errors: "all" });

/** Remove excess keys through the authored kind of each element of the
 *  top-level `phases` list before the union can choose another kind. Each
 *  element of a repeat's `phases` is a phase, whatever keys it holds. A
 *  malformed element makes recovery fail for the whole file. */
function recoverAuthoredEntries(node: DocumentNode) {
  if (!Array.isArray(node.phases)) return node;
  const ignoring = { onExcessProperty: "ignore", errors: "all" } as const;
  return {
    ...node,
    phases: node.phases.map((child: unknown) => {
      const kind = authoredPhaseOrRepeatKind(child);
      if (kind === undefined || !isNode(child)) return child;
      if (kind === "phase") return Schema.decodeUnknownSync(PHASE_OR_REPEAT_SCHEMAS.phase, ignoring)(child);
      const body = Array.isArray(child.phases) ? { phases: child.phases.map((phase: unknown) => Schema.decodeUnknownSync(PHASE_OR_REPEAT_SCHEMAS.phase, ignoring)(phase)) } : {};
      return Schema.decodeUnknownSync(PHASE_OR_REPEAT_SCHEMAS.repeat, ignoring)({ ...child, ...body });
    }),
  };
}

/** The problems of one top-level element with the schema's problems of
 *  each repeat inside its `phases` replaced by one refusal that names the
 *  shape. A repeat's body decodes each element as a phase, so a nested
 *  repeat otherwise reads as a phase with unknown keys and no id. */
function nestedRepeats(file: string, index: number, entry: unknown, diagnostics: readonly WorkflowFileDiagnostic[]): readonly WorkflowFileDiagnostic[] {
  const body = isNode(entry) && Array.isArray(entry.phases) ? entry.phases : [];
  const nested = body.flatMap((child: unknown, at: number) => authoredPhaseOrRepeatKind(child) === "repeat" ? [`phases.${index}.phases.${at}`] : []);
  if (nested.length === 0) return diagnostics;
  return [
    ...diagnostics.filter(({ keyPath }) => !nested.some((at) => keyPath === at || keyPath.startsWith(`${at}.`))),
    ...nested.map((keyPath) => ({ file, keyPath, message: "is a repeat inside a repeat, which a workflow cannot hold; put its phases in the outer repeat's phases, or move it to its own place after the outer repeat" })),
  ];
}

/** The problems of the top-level `phases` list, with the problems of each
 *  element that names its kind replaced by the problems of that kind alone.
 *  An element decodes through the union of a phase and a repeat, whose
 *  failure lists what each kind would need, so a phase with a bad key would
 *  otherwise read as a repeat too. An element that names no kind keeps the
 *  union's problems. A repeat's own phases decode through the phase schema
 *  alone, so they need no narrowing. */
function narrowPhaseEntries(file: string, document: unknown, diagnostics: readonly WorkflowFileDiagnostic[]): readonly WorkflowFileDiagnostic[] {
  const phases = isNode(document) ? document.phases : undefined;
  if (!Array.isArray(phases)) return diagnostics;
  const within = (diagnostic: WorkflowFileDiagnostic, index: number): boolean => {
    const at = `phases.${index}`;
    return diagnostic.keyPath === at || diagnostic.keyPath.startsWith(`${at}.`);
  };
  const narrowed = new Map<number, readonly WorkflowFileDiagnostic[]>();
  for (const [index, entry] of phases.entries()) {
    const kind = authoredPhaseOrRepeatKind(entry);
    if (kind === undefined || !diagnostics.some((diagnostic) => within(diagnostic, index))) continue;
    const decoded = decodeStrictly(PHASE_OR_REPEAT_SCHEMAS[kind])(entry);
    const own = nestedRepeats(file, index, entry, Result.isFailure(decoded) ? issueDiagnostics(file, document, decoded.failure.issue, ["phases", index]) : []);
    // A kind that decodes the element leaves the union's problems as the
    // only statement of what is wrong.
    if (own.length > 0) narrowed.set(index, own);
  }
  const emitted = new Set<number>();
  return diagnostics.flatMap((diagnostic) => {
    const index = [...narrowed.keys()].find((candidate) => within(diagnostic, candidate));
    if (index === undefined) return [diagnostic];
    if (emitted.has(index)) return [];
    emitted.add(index);
    return narrowed.get(index) ?? [];
  });
}

/** Where each phase, named agent, and repeat of one workflow is: its key
 *  path by its label, by its agent record id, and by the node id that
 *  compile gives it. Validation and verification name a place by its label,
 *  its record id, or its node id, and a diagnostic names the label and the
 *  key path. */
export interface WorkflowPhaseLocations {
  readonly byLabel: ReadonlyMap<string, string>;
  readonly byRecord: ReadonlyMap<string, { readonly label: string; readonly keyPath: string }>;
  readonly byNodeId: ReadonlyMap<string, { readonly label: string; readonly keyPath: string }>;
}

export function workflowPhaseLocations(workflow: Pick<WorkflowDefinition, "id" | "phases">): WorkflowPhaseLocations {
  const byLabel = new Map<string, string>();
  const byRecord = new Map<string, { label: string; keyPath: string }>();
  const byNodeId = new Map<string, { label: string; keyPath: string }>();
  const heads = new Map<WorkflowPhase, WorkflowPhase>();
  for (const stream of streams(workflow)) for (const phase of stream) if (stream[0] !== undefined) heads.set(phase, stream[0]);
  const place = (label: string, keyPath: string, nodeId: string | undefined, recordId?: string): void => {
    if (!byLabel.has(label)) byLabel.set(label, keyPath);
    if (recordId !== undefined && !byRecord.has(recordId)) byRecord.set(recordId, { label, keyPath });
    if (nodeId !== undefined && !byNodeId.has(nodeId)) byNodeId.set(nodeId, { label, keyPath });
  };
  for (const [topIndex, entry] of workflow.phases.entries()) {
    if (isRepeat(entry)) place(repeatLabel(topIndex), `phases.${topIndex}`, topNodeId(workflow.id, topIndex));
  }
  walkPhases(workflow.phases, (phase, location) => {
    const keyPath = location.repeat === undefined ? `phases.${location.topIndex}` : `phases.${location.topIndex}.phases.${location.index}`;
    // A stream phase after its first compiles to no node of its own: the
    // list node of its stream holds its agents.
    const head = heads.get(phase);
    const nodeId = head === undefined || head === phase ? phaseNodeId(workflow.id, location) : undefined;
    place(location.label, keyPath, nodeId, phase.agents === undefined ? phase.phase : undefined);
    for (const [index, { agent }] of namedAgents(phase).entries()) {
      place(agentLabel(agent), `${keyPath}.agents.${index}`, nodeId === undefined ? undefined : namedAgentNodeId(nodeId, index), agent);
    }
  });
  return { byLabel, byRecord, byNodeId };
}

/** The keys that a message may name right after its label, each located
 *  under the place that the label names. */
const LOCATED_KEYS = new Set(["over", "if", "reads", "join", "votes", "label", "agents", "runs", "brief", "persona", "model", "effort", "writes", "retry", "output", "dependencies", "subagents"]);
const REPEAT_KEYS = new Set(["while", "each", "reassess", "max", "stuck"]);

/** The key path of `place` with the key that `rest` names first, when it
 *  names one, such as `phases.2.reads`. */
function keyOf(place: string, rest: string, repeat: boolean): string {
  const key = /^([a-z_]+)[ .:]/u.exec(rest)?.[1];
  if (key === undefined) return place;
  if (repeat) return REPEAT_KEYS.has(key) ? `${place}.repeat.${key}` : place;
  return LOCATED_KEYS.has(key) ? `${place}.${key}` : place;
}

/** The key path and the text of a message about one place. A message that
 *  starts with a key path inside the place's record, as in
 *  `writes.0.supersedes: ...`, is located at that key path and loses the
 *  prefix. */
function locatedAt(file: string, entry: string, place: string, rest: string, repeat: boolean): WorkflowFileDiagnostic {
  const nested = repeat ? undefined : /^([a-z_]+(?:\.\d+\.[a-z_]+)+): ([\s\S]*)$/u.exec(rest);
  if (nested?.[1] !== undefined && nested[2] !== undefined && LOCATED_KEYS.has(nested[1].split(".")[0] ?? "")) {
    return { file, entry, keyPath: `${place}.${nested[1]}`, message: nested[2] };
  }
  return { file, entry, keyPath: keyOf(place, rest, repeat), message: rest };
}

/** Locate one message that brief loading or semantic validation wrote. A
 *  message that names a phase, an agent, a repeat, an agent record, or the
 *  input keeps that location; any other message is located at the root of
 *  the file. */
function locatedMessage(file: string, message: string, locations: WorkflowPhaseLocations): WorkflowFileDiagnostic {
  const input = /^Workflow "[^"]*" input: ([\s\S]*)$/u.exec(message);
  if (input?.[1] !== undefined) return { file, keyPath: "input", message: input[1] };
  // Brief loading and agent policy name the agent record.
  const record = /^Workflow "[^"]*" agent "([^"]+)":? ([\s\S]*)$/u.exec(message) ?? /^Agent "([^"]+)" ([\s\S]*)$/u.exec(message);
  if (record?.[1] !== undefined && record[2] !== undefined) {
    const at = locations.byRecord.get(record[1]);
    if (at !== undefined) return locatedAt(file, at.label, at.keyPath, record[2], false);
  }
  // Validation and compilation name the workflow before the place, as in
  // `Workflow "review": Phase "fix" reads names "plan", ...`.
  const unprefixed = /^Workflow "[^"]*": ([\s\S]*)$/u.exec(message)?.[1] ?? message;
  const place = /^((?:Phase|Agent) "[^"]+"|Repeat \d+) ([\s\S]*)$/u.exec(unprefixed);
  if (place?.[1] !== undefined && place[2] !== undefined) {
    const keyPath = locations.byLabel.get(place[1]);
    if (keyPath !== undefined) return locatedAt(file, place[1], keyPath, place[2], place[1].startsWith("Repeat "));
  }
  return { file, keyPath: "(root)", message };
}

/** A file that decoded, with what the loader's boundary rules changed. */
export interface DecodedWorkflowFile {
  readonly definition: AuthoredWorkflowDefinition;
  /** The step-grammar conversion, when the file states the retired step
   *  grammar. */
  readonly stepGrammar?: StepGrammarConversion;
  /** The key path of each retired key that the loader dropped. A saved file
   *  keeps loading with them; a launched file must not state them. */
  readonly retiredKeys: readonly string[];
  /** Each mistake with one reading that the loader repaired. */
  readonly repairs: readonly AuthoredRepair[];
}

export type WorkflowFileDecode =
  | ({ readonly ok: true } & DecodedWorkflowFile)
  | {
    readonly ok: false;
    readonly diagnostics: readonly WorkflowFileDiagnostic[];
    /** A definition to judge, not run, when only excess keys prevented decoding. */
    readonly recovered?: DecodedWorkflowFile;
  };

/** A YAML syntax error as the author fixes it: where it is, and why. A
 *  colon followed by a space in a flow mapping has more than one reading,
 *  so the reader cannot repair it, and the message names the fix. */
function yamlErrorMessage(error: unknown): string {
  if (error instanceof UnsupportedWorkflowYamlError) return error.message;
  if (!(error instanceof yaml.YAMLException)) return `The file is not valid YAML: ${errorMessage(error)}`;
  const at = error.mark === undefined ? "" : ` at line ${error.mark.line + 1}, column ${error.mark.column + 1}`;
  const remedy = error.reason.includes("flow") ? "; quote a text value in a { } flow mapping that holds a comma or a colon" : "";
  return `The file is not valid YAML${at}: ${error.reason}${remedy}`;
}

/** What the loader's boundary rules changed in one document. */
function conversions(normalized: NormalizedAuthoredDocument): Omit<DecodedWorkflowFile, "definition"> {
  return {
    retiredKeys: normalized.retiredKeys,
    repairs: normalized.repairs,
    ...(normalized.stepGrammar ? { stepGrammar: normalized.stepGrammar } : {}),
  };
}

/** Parse and strictly decode the text of one workflow file. The loader's
 *  boundary rules apply first, so this accepts exactly what the registry
 *  loads, and every decode issue is located (refer to
 *  {@link WorkflowFileDiagnostic}). Excess keys still refuse the file, but
 *  a definition without those keys lets later checks report their problems.
 *  A session launch refuses retired bindings before conversion because its
 *  recorded workflow cannot rebuild skill-derived content ids. */
export function decodeWorkflowFile(input: { readonly file: string; readonly content: string; readonly skills?: SkillRegistryRevision; readonly retiredBindings?: "refuse" }): WorkflowFileDecode {
  const { file } = input;
  let raw: unknown;
  try {
    raw = parseWorkflowYaml(input.content);
  } catch (error) {
    return { ok: false, diagnostics: [{ file, keyPath: "(root)", message: yamlErrorMessage(error) }] };
  }
  if (input.retiredBindings === "refuse" && isNode(raw) && "bindings" in raw) {
    return { ok: false, diagnostics: [{ file, keyPath: "(root)", message: "the file uses the retired bindings form; write it in the phase grammar" }] };
  }
  let normalized: NormalizedAuthoredDocument;
  try {
    normalized = normalizeAuthoredDocument(raw, input.content, input.skills);
  } catch (error) {
    return { ok: false, diagnostics: [{ file, keyPath: "(root)", message: errorMessage(error) }] };
  }
  const decoded = decodeStrictly(WorkflowDefinitionSchema)(normalized.document);
  if (Result.isFailure(decoded)) {
    const diagnostics = narrowPhaseEntries(file, normalized.document, issueDiagnostics(file, normalized.document, decoded.failure.issue));
    let recovered: AuthoredWorkflowDefinition | undefined;
    try {
      recovered = Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "ignore", errors: "all" })(isNode(normalized.document) ? recoverAuthoredEntries(normalized.document) : normalized.document);
    } catch {
      // A shape defect is not an excess key, so later checks have no definition.
    }
    return {
      ok: false,
      diagnostics,
      ...(recovered ? {
        recovered: { definition: recovered, ...conversions(normalized) },
      } : {}),
    };
  }
  return { ok: true, definition: decoded.success, ...conversions(normalized) };
}

export type WorkflowFileLoad =
  | { readonly ok: true; readonly workflow: WorkflowDefinition }
  /** `id` is the id the file declares, when the file decoded far enough to
   *  declare one. `loaded` is the workflow whose briefs loaded when only
   *  semantic validation refused it, so a reader can still judge what each
   *  agent asks for. */
  | { readonly ok: false; readonly id?: string; readonly loaded?: WorkflowDefinition; readonly diagnostics: readonly WorkflowFileDiagnostic[] };

/** Load the briefs of one decoded file and judge it as the registry judges
 *  a candidate: its briefs, contracts, and input contract load once, and
 *  semantic validation, structural admission among it, runs against
 *  `skills`. `location` resolves contract paths when the verifier reads a file. */
export function loadDecodedWorkflow(input: {
  readonly file: string;
  readonly decoded: DecodedWorkflowFile;
  readonly location: AssetLocation | undefined;
  readonly provenance: DefinitionProvenance;
  readonly skills: SkillRegistryRevision;
  readonly reader?: DefinitionAssetReader;
}): WorkflowFileLoad {
  const { file, decoded: { definition, stepGrammar } } = input;
  const locations = workflowPhaseLocations(definition);
  let workflow: WorkflowDefinition;
  try {
    workflow = withLoadedContent(definition, {
      location: input.location,
      reader: input.reader ?? definitionAssets,
      provenance: input.provenance,
      ...(stepGrammar ? { stepGrammar: stepGrammar.view } : {}),
    });
  } catch (error) {
    const failures = error instanceof AggregateError ? error.errors : [error];
    return { ok: false, id: definition.id, diagnostics: failures.map((failure) => locatedMessage(file, errorMessage(failure), locations)) };
  }
  const semantic = validateWorkflowDefinition(workflow, input.skills);
  if (semantic.length > 0) {
    return { ok: false, id: definition.id, loaded: workflow, diagnostics: semantic.map(({ message }) => locatedMessage(file, message, locations)) };
  }
  return { ok: true, workflow };
}

/** The one-file pipeline of `flywheel workflow verify <file>`: decode the
 *  text of one workflow file, then load and judge it with `provenance`. A
 *  path launch runs the same two passes, {@link decodeWorkflowFile} and
 *  {@link loadDecodedWorkflow}, and adds its own refusals between and after
 *  them (`path-workflow.ts`). So a file that verifies here can still be
 *  refused as a launch. The layer decides the rules: a registered layer
 *  needs each counted list to declare `max` and each list that a phase runs
 *  over to declare `unique`, and the `session` layer gives the defaults of
 *  a launch. */
export function loadWorkflowFile(input: {
  readonly file: string;
  readonly content: string;
  readonly location: AssetLocation | undefined;
  readonly provenance: Omit<DefinitionProvenance, "id">;
  readonly skills: SkillRegistryRevision;
  readonly reader?: DefinitionAssetReader;
}): WorkflowFileLoad {
  const decoded = decodeWorkflowFile(input);
  if (!decoded.ok) {
    if (!decoded.recovered) return decoded;
    const loaded = loadDecodedWorkflow({ ...input, decoded: decoded.recovered, provenance: { ...input.provenance, id: decoded.recovered.definition.id } });
    return {
      ok: false,
      id: decoded.recovered.definition.id,
      ...(loaded.ok ? { loaded: loaded.workflow } : loaded.loaded ? { loaded: loaded.loaded } : {}),
      diagnostics: [...decoded.diagnostics, ...(loaded.ok ? [] : loaded.diagnostics)],
    };
  }
  return loadDecodedWorkflow({ ...input, decoded, provenance: { ...input.provenance, id: decoded.definition.id } });
}
