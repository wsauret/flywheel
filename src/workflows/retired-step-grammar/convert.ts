/** Conversion of a saved workflow file from the step grammar (`steps` and
 *  `flow`) to the phase grammar (`phases`). A workflow file is an external
 *  boundary, and a person's saved file outlives the build that wrote it, so
 *  the loader converts it when it reads it and the file earns one warning
 *  that names each change. The conversion is a pure function of the file's
 *  text, so a Resume that rebuilds a recorded definition repeats it exactly.
 *
 *  Each agent record keeps the step record key that it ran, which stored
 *  nodes and attempts of a paused run name as `definitionId`; a step that
 *  runs in a second place takes `<id>-<n>` with `runs: <id>`. Every reference
 *  by entry id names that key instead.
 *
 *  Remove after 2027-04-30. */
import { Schema } from "effect";
import type { RetiredBinding } from "../retired-bindings.js";
import { parseFieldRef } from "../field-ref.js";
import { WORKFLOW_INPUT_SOURCE_ID } from "../workflow-schema.js";
import { SHIPPED_PLAN_CONTRACT } from "../retired-handoff-contracts.js";
import { resolveFlowOrder } from "./flow-order.js";
import {
  isWhileNode,
  loopBody,
  mapStages,
  StepGrammarWorkflowSchema,
  whileMap,
  type StepGrammarWorkflow,
  type WorkflowFlowEntry,
  type WorkflowMapEntry,
  type WorkflowStep,
  type WorkflowStepRef,
} from "./schema.js";
import type { RetiredStepGrammarView } from "./view.js";

type RawDocument = { readonly [key: string]: unknown };

/** The retry of a converted phase or agent. */
interface ConvertedRetry {
  readonly max: number;
  readonly stuck?: true;
}

/** The record keys of one converted phase or named agent, in the phase
 *  grammar's spelling, before the strict decode reads them. */
interface ConvertedRecord {
  name?: string;
  runs?: string;
  brief?: string;
  writes?: WorkflowStep["writes"];
  reads?: readonly string[];
  model?: WorkflowStep["model"];
  effort?: WorkflowStep["effort"];
  output?: WorkflowStep["output"];
  dependencies?: WorkflowStep["dependencies"];
  subagents?: WorkflowStep["agents"];
  retry?: ConvertedRetry;
}

/** One converted phase: its record, and what the entry that it came from
 *  stated about its place. */
interface ConvertedPhase extends ConvertedRecord {
  phase: string;
  if?: string;
  over?: string;
  label?: string;
  votes?: WorkflowMapEntry["votes"];
  join?: WorkflowMapEntry["join"];
  agents?: readonly (ConvertedRecord & { readonly agent: string })[];
}

/** One converted repeat over its own phases. */
interface ConvertedRepeat {
  readonly repeat: { readonly while: string; readonly max: number; readonly stuck?: true } | { readonly each: string; readonly reassess?: string };
  readonly phases: readonly ConvertedPhase[];
}

type ConvertedElement = ConvertedPhase | ConvertedRepeat;

/** Whether a document states the step grammar: `steps` or `flow`, and no
 *  `phases`. */
export function isStepGrammarDocument(document: RawDocument): boolean {
  return !("phases" in document) && ("steps" in document || "flow" in document);
}

/** One converted file: the phase-grammar document, what the definition keeps
 *  of the step-grammar file, and every change, for the one warning. */
export interface StepGrammarConversion {
  readonly document: RawDocument;
  readonly view: Omit<RetiredStepGrammarView, "workflow"> & { readonly workflow: StepGrammarWorkflow };
  readonly notes: readonly string[];
}

/** The prefix of a bundled step file path that the core briefs folder
 *  replaced. */
const BUNDLED_STEP_PREFIX = "bundled:steps/";

/** The list field of the shipped plan contract, which its `phases` became,
 *  so a reference to it keeps naming the plan's items. */
const RETIRED_PLAN_LIST = { from: "phases", to: "milestones" } as const;

/** The one warning a converted file earns. */
export function stepGrammarWarning(notes: readonly string[]): string {
  return `This file uses the retired step grammar, which Flywheel converted when it read it: ${notes.join("; ")}. Rewrite it in the phase grammar; load the workflow-authoring skill.`;
}

/** Decode the step-grammar record strictly. A file in this form that does
 *  not decode fails with the decode error, as it did before phases. */
function decodeStepGrammar(document: RawDocument): typeof StepGrammarWorkflowSchema.Type {
  return Schema.decodeUnknownSync(StepGrammarWorkflowSchema, { onExcessProperty: "error", errors: "all" })(document);
}

/** Convert one step-grammar document. `bindings` are the bindings that the
 *  older bindings conversion read first, and `briefIds` the content ids it
 *  kept, both keyed by step id. Throws the decode error of a malformed
 *  file. */
export function convertStepGrammar(
  document: RawDocument,
  bindings?: ReadonlyMap<string, RetiredBinding>,
  keptContentIds: ReadonlyMap<string, string> = new Map(),
): StepGrammarConversion {
  const decoded = decodeStepGrammar(document);
  const workflow: StepGrammarWorkflow = bindings === undefined ? decoded : { ...decoded, retiredBindings: bindings };
  return new Converter(workflow, keptContentIds).convert();
}

/** A step entry's output, a map's join output, or a loop over a map: the
 *  record key that a reference to its local id now names. */
class Converter {
  private readonly notes: string[] = ["steps and flow became phases"];
  private readonly taken = new Set<string>();
  private readonly uses = new Map<string, number>();
  private readonly briefIds = new Map<string, string>();
  /** The record key that each entry local id names. */
  private readonly localKeys = new Map<string, string>();
  /** The first place key of each step id. */
  private readonly firstPlace = new Map<string, string>();
  /** The step id that each place key runs. */
  private readonly stepOfKey = new Map<string, string>();

  constructor(private readonly workflow: StepGrammarWorkflow, private readonly keptContentIds: ReadonlyMap<string, string>) {
    for (const stepId of Object.keys(workflow.steps)) this.taken.add(stepId);
  }

  convert(): StepGrammarConversion {
    this.assignPlaces(this.workflow.flow);
    const phases = this.convertList(this.workflow.flow, []);
    // The frozen step grammar defaults catalog keys. Remove after 2027-04-30.
    const {
      steps: _steps, flow: _flow, guardrails, retiredBindings: _bindings, provenance: _provenance,
      use_when: _useWhen, confirmation_template: _confirmation, requires_description: _requiresDescription,
      "user-invocable": _userInvocable, "disable-model-invocation": _disableModelInvocation, ...header
    } = this.workflow;
    const unused = Object.keys(this.workflow.steps).filter((stepId) => !this.firstPlace.has(stepId));
    if (unused.length > 0) this.notes.push(`unused step ${unused.map((id) => JSON.stringify(id)).join(", ")} dropped`);
    const document = { ...header, phases, ...(guardrails === undefined ? {} : { guardrails: this.guardrails(guardrails) }) };
    return {
      document,
      view: { workflow: this.workflow, stepIds: this.stepOfKey, briefIds: this.briefIds },
      notes: this.notes,
    };
  }

  private guardrails(guardrails: NonNullable<typeof StepGrammarWorkflowSchema.Type["guardrails"]>) {
    const { max_queue_length, max_session_inserts, ...rest } = guardrails;
    if (max_queue_length !== undefined) this.notes.push("guardrails.max_queue_length became max_attempts");
    if (max_session_inserts !== undefined) this.notes.push("guardrails.max_session_inserts became max_inserts");
    return {
      ...rest,
      ...(max_queue_length === undefined ? {} : { max_attempts: max_queue_length }),
      ...(max_session_inserts === undefined ? {} : { max_inserts: max_session_inserts }),
    };
  }

  /** A new record key for one more place of `stepId`: the step id at its
   *  first place, else `<id>-<n>`. */
  private place(stepId: string): string {
    const count = (this.uses.get(stepId) ?? 0) + 1;
    this.uses.set(stepId, count);
    if (count === 1) {
      this.firstPlace.set(stepId, stepId);
      this.stepOfKey.set(stepId, stepId);
      return stepId;
    }
    let n = count;
    let key = `${stepId}-${n}`;
    while (this.taken.has(key)) key = `${stepId}-${n += 1}`;
    this.taken.add(key);
    this.stepOfKey.set(key, stepId);
    return key;
  }

  /** The field that `<key>.<field>` names now: a record whose output is the
   *  shipped plan contract names its list `milestones`, which was
   *  `phases`. */
  private field(key: string, field: string): string {
    const output = this.workflow.steps[this.stepOfKey.get(key) ?? key]?.output;
    if (output !== SHIPPED_PLAN_CONTRACT || field !== RETIRED_PLAN_LIST.from) return field;
    this.notes.push(`"${key}.${RETIRED_PLAN_LIST.from}" became "${key}.${RETIRED_PLAN_LIST.to}", the list of the shipped plan contract`);
    return RETIRED_PLAN_LIST.to;
  }

  /** A fresh phase id for a layer of named agents. */
  private layerId(): string {
    let n = 1;
    while (this.taken.has(`parallel-${n}`)) n += 1;
    const id = `parallel-${n}`;
    this.taken.add(id);
    return id;
  }

  /** The place keys of every entry, in preorder, so that every reference
   *  resolves before any phase converts. */
  private readonly keys = new Map<object, readonly string[]>();

  private assignPlaces(flow: readonly WorkflowFlowEntry[]): void {
    for (const entry of flow) {
      if ("phase" in entry) {
        this.assignPlaces(entry.flow);
        continue;
      }
      if ("step" in entry) {
        const keys = [this.place(entry.step), ...followUps(entry).map(({ step }) => this.place(step))];
        this.keys.set(entry, keys);
        this.localKeys.set(entry.id ?? entry.step, keys[0] ?? entry.step);
        continue;
      }
      if ("map" in entry) {
        this.placeMap(entry);
        continue;
      }
      const map = whileMap(entry);
      if (map !== undefined) {
        this.placeMap(map);
        continue;
      }
      const keys = loopBody(entry).map(({ step }) => this.place(step));
      this.keys.set(entry, keys);
      if (entry.id !== undefined) this.localKeys.set(entry.id, keys.at(-1) ?? entry.id);
    }
  }

  /** The place keys of a map's stages. A reference to the map names its
   *  last stage. */
  private placeMap(map: WorkflowMapEntry): void {
    const keys = mapStages(map).map((step) => this.place(step));
    this.keys.set(map, keys);
    this.localKeys.set(map.id, keys.at(-1) ?? map.id);
  }

  /** The record key a reference by entry local id names. */
  private local(id: string): string {
    if (id === WORKFLOW_INPUT_SOURCE_ID) return id;
    return this.localKeys.get(id) ?? this.firstPlace.get(id) ?? id;
  }

  /** A `<id>.<field>` reference rewritten to name a record key. */
  private ref(raw: string, resolve: (id: string) => string = (id) => this.local(id)): string {
    const { source: step, field } = parseFieldRef(raw);
    const key = resolve(step);
    return `${key}.${this.field(key, field)}`;
  }

  /** Convert one flow list to phases. `after` and containers flatten by
   *  longest path: a layer of plain steps becomes one phase of named agents,
   *  and any other layer runs in sequence. */
  private convertList(flow: readonly WorkflowFlowEntry[], containers: readonly string[]): ConvertedElement[] {
    const order = resolveFlowOrder(flow).get(flow);
    const prerequisites = order?.prerequisites ?? flow.map((_, index) => index === 0 ? [] : [index - 1]);
    const depth: number[] = [];
    for (const index of flow.keys()) {
      depth[index] = Math.max(-1, ...(prerequisites[index] ?? []).map((prerequisite) => depth[prerequisite] ?? 0)) + 1;
    }
    const layers = new Map<number, number[]>();
    for (const index of flow.keys()) layers.set(depth[index] ?? 0, [...layers.get(depth[index] ?? 0) ?? [], index]);
    const explicit = flow.some((entry) => entry.after !== undefined);
    if (explicit) this.notes.push(`the after order of ${containers.length === 0 ? "the top-level flow" : `phase "${containers.join("/")}"`} became phases in order of their longest path`);
    const phases: ConvertedElement[] = [];
    for (const [, indexes] of [...layers.entries()].toSorted(([left], [right]) => left - right)) {
      const entries = indexes.map((index) => flow[index]).filter((entry): entry is WorkflowFlowEntry => entry !== undefined);
      const plainSteps = entries.filter((entry): entry is WorkflowStepRef => "step" in entry && entry.then === undefined);
      if (entries.length > 1 && plainSteps.length === entries.length) {
        phases.push(this.namedLayer(plainSteps));
        continue;
      }
      if (entries.length > 1) this.notes.push(`${entries.length} entries that ran at the same time now run one after another`);
      for (const entry of entries) phases.push(...this.convertEntry(entry, containers));
    }
    return phases;
  }

  private namedLayer(entries: readonly WorkflowStepRef[]): ConvertedPhase {
    const id = this.layerId();
    this.notes.push(`steps ${entries.map(({ step }) => JSON.stringify(step)).join(", ")} became the named agents of phase "${id}"`);
    return {
      phase: id,
      agents: entries.map((entry) => {
        const key = this.keys.get(entry)?.[0] ?? entry.step;
        const { phase: _phase, ...record } = this.record(entry.step, key, entry.id);
        return { agent: key, ...record, ...(entry.retry === undefined ? {} : { retry: retry(entry.retry) }) };
      }),
    };
  }

  private convertEntry(entry: WorkflowFlowEntry, containers: readonly string[]): ConvertedElement[] {
    if ("phase" in entry) {
      if (entry.limits !== undefined) this.notes.push(`the limits of phase "${entry.phase}" were dropped`);
      return this.convertList(entry.flow, [...containers, entry.phase]);
    }
    if ("step" in entry) return this.stepEntry(entry);
    if ("map" in entry) return this.mapEntry(entry);
    const keys = this.keys.get(entry) ?? [];
    if (isWhileNode(entry)) {
      const map = whileMap(entry);
      if (map !== undefined) {
        const { field } = parseFieldRef(entry.while);
        const key = this.keys.get(map)?.at(-1) ?? map.id;
        return [{ repeat: { while: `${key}.${this.field(key, field)}`, max: entry.maxIterations }, phases: this.mapEntry(map) }];
      }
      const body = loopBody(entry);
      const evaluator = parseFieldRef(entry.while);
      const at = body.findIndex(({ step }) => step === evaluator.source);
      const phases = body.map(({ step }, index) => this.record(step, keys[index] ?? step));
      const key = keys[at] ?? evaluator.source;
      return [{
        repeat: { while: `${key}.${this.field(key, evaluator.field)}`, max: entry.maxIterations, ...(entry.detectStuck ? { stuck: true } : {}) },
        phases,
      }];
    }
    const body = loopBody(entry);
    const phases = body.map(({ step }, index) => this.record(step, keys[index] ?? step));
    const reassess = body.findIndex(({ slot }) => slot === "reassess");
    return [{
      repeat: {
        each: this.ref(entry.for, (id) => this.firstPlace.get(id) ?? id),
        ...(reassess < 0 ? {} : { reassess: keys[reassess] }),
      },
      phases,
    }];
  }

  private stepEntry(entry: WorkflowStepRef): ConvertedPhase[] {
    const keys = this.keys.get(entry) ?? [entry.step];
    const first = this.record(entry.step, keys[0] ?? entry.step, entry.id);
    if (entry.retry !== undefined) first.retry = retry(entry.retry);
    const phases: ConvertedPhase[] = [first];
    let prior = keys[0] ?? entry.step;
    for (const [index, followUp] of followUps(entry).entries()) {
      const key = keys[index + 1] ?? followUp.step;
      const condition = followUp.when === undefined ? prior : `${prior}.${this.field(prior, followUp.when)}`;
      phases.push({
        ...this.record(followUp.step, key),
        if: condition,
        // The retry of a step entry applied to every step of its then chain.
        ...(entry.retry === undefined ? {} : { retry: retry(entry.retry) }),
      });
      this.notes.push(`then "${followUp.step}" became phase "${key}" with if: ${condition}`);
      prior = key;
    }
    return phases;
  }

  private mapEntry(map: WorkflowMapEntry): ConvertedPhase[] {
    const keys = this.keys.get(map) ?? mapStages(map);
    const stages = mapStages(map);
    const bareCollect = map.join.reducer === "collect" && map.join.with === undefined && map.join.write === undefined;
    if (bareCollect) this.notes.push(`map "${map.id}": join: { reducer: collect } was dropped, because collect is the default`);
    return stages.map((step, index) => {
      const key = keys[index] ?? step;
      const phase = this.record(step, key);
      phase.over = index === 0 ? this.ref(map.map) : keys[index - 1];
      if (index === 0) {
        if (map.label !== undefined) phase.label = map.label;
        if (map.votes !== undefined) phase.votes = map.votes;
      }
      if (map.retry !== undefined) phase.retry = retry(map.retry);
      if (index === stages.length - 1) {
        if (!bareCollect) phase.join = map.join;
        if (map.id !== key && phase.name === undefined) phase.name = map.name ?? map.id;
      }
      return phase;
    });
  }

  /** The phase that runs step `stepId` at place `key`, with the step's
   *  record keys. The step's content goes to the first place; a later place
   *  runs it by name. */
  private record(stepId: string, key: string, entryId?: string): ConvertedPhase {
    const step: WorkflowStep | undefined = this.workflow.steps[stepId];
    const phase: ConvertedPhase = { phase: key };
    if (step === undefined) return phase;
    const name = step.name ?? (entryId !== undefined && entryId !== stepId ? entryId : undefined);
    if (name !== undefined) phase.name = name;
    if (step.writes !== undefined) phase.writes = step.writes;
    if (step.reads !== undefined) phase.reads = step.reads.map((id) => this.local(id));
    if (step.model !== undefined) phase.model = step.model;
    if (step.effort !== undefined) phase.effort = step.effort;
    const first = key === stepId;
    if (step.external !== undefined) {
      phase.runs = `skill:${step.external.skill}`;
      return phase;
    }
    const kept = this.keptContentIds.get(stepId);
    if (step.instructions !== undefined) {
      if (!first) {
        phase.runs = stepId;
        return phase;
      }
      phase.brief = step.instructions;
      if (kept !== undefined) this.briefIds.set(key, kept);
      if (step.output !== undefined) phase.output = step.output;
      if (step.dependencies !== undefined) phase.dependencies = step.dependencies;
      if (step.agents !== undefined) phase.subagents = step.agents;
      return phase;
    }
    const file = step.file ?? "";
    if (file.startsWith(BUNDLED_STEP_PREFIX) && file.endsWith(".md") && !file.slice(BUNDLED_STEP_PREFIX.length).includes("/")) {
      const brief = file.slice(BUNDLED_STEP_PREFIX.length, -".md".length);
      if (brief !== key) phase.runs = brief;
      return phase;
    }
    if (!first) {
      phase.runs = stepId;
      return phase;
    }
    return phase;
  }

}

function followUps(entry: WorkflowStepRef): readonly { readonly step: string; readonly when?: string }[] {
  const chain: { readonly step: string; readonly when?: string }[] = [];
  for (let next = entry.then; next !== undefined; next = next.then) chain.push({ step: next.step, ...(next.when === undefined ? {} : { when: next.when }) });
  return chain;
}

function retry(value: { readonly maxIterations: number; readonly detectStuck: boolean }): ConvertedRetry {
  return { max: value.maxIterations, ...(value.detectStuck ? { stuck: true } : {}) };
}
