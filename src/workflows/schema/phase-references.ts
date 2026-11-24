import { FieldRefError, parseFieldRef } from "./field-ref.js";
import {
  allPhases,
  isRepeat,
  isStreamOver,
  isWhileRepeat,
  namedAgents,
  phaseKind,
  repeatLabel,
  streams,
  WORKFLOW_INPUT_SOURCE_ID,
  type PhaseLocation,
  type WorkflowDefinition,
  type WorkflowPhase,
} from "./workflow-schema.js";

// The names that a phase grammar file uses to refer to an earlier output:
// `over`, `if`, `reads`, `repeat.while`, and `repeat.each`. Phases run in
// order, so a reference is good when its target finishes before the reader
// starts. This module judges every reference by authored position alone,
// so load-time validation and compilation give one verdict before any
// graph exists.

/** What one name refers to: a phase of one agent, a named agent, a phase of
 *  named agents, or the last phase of a stream, which stands for the stream's
 *  join. A phase of a stream that is not its last is no target, because no
 *  output holds all of its items. */
interface Target {
  readonly id: string;
  readonly phase: WorkflowPhase;
  readonly location: PhaseLocation;
  /** For a phase of a stream that is not its last, the last phase. */
  readonly lastOfStream?: string;
}

/** Every name of a workflow, keyed by its id. */
function targets(workflow: Pick<WorkflowDefinition, "phases">): ReadonlyMap<string, Target> {
  const lastOf = new Map<string, string>();
  for (const stream of streams(workflow)) {
    const last = stream.at(-1);
    if (last !== undefined) for (const phase of stream) lastOf.set(phase.phase, last.phase);
  }
  const found = new Map<string, Target>();
  for (const { phase, location } of allPhases(workflow)) {
    const kind = phaseKind(phase);
    if (kind === "named") {
      found.set(phase.phase, { id: phase.phase, phase, location });
      for (const { agent } of namedAgents(phase)) found.set(agent, { id: agent, phase, location });
    } else if (kind === "single") {
      found.set(phase.phase, { id: phase.phase, phase, location });
    } else {
      const last = lastOf.get(phase.phase);
      found.set(phase.phase, { id: phase.phase, phase, location, ...(last === phase.phase ? {} : { lastOfStream: last ?? phase.phase }) });
    }
  }
  return found;
}

/** Where a reader starts. The agents of a stream phase start when the first
 *  phase of their stream starts, so they read only what finished before it
 *  (refer to "stream" in docs/terminology.md). */
interface ReaderPlace {
  readonly location: PhaseLocation;
  /** The repeat that the reader is, for `repeat.while` and `repeat.each`. */
  readonly repeatTopIndex?: number;
}

/** Whether `target` finishes before `reader` starts. A body phase read from
 *  the same round must stand earlier in the body; read from outside, the
 *  whole repeat must stand earlier. */
function finishesBefore(target: PhaseLocation, reader: ReaderPlace): boolean {
  const readerRepeat = reader.repeatTopIndex ?? reader.location.repeat?.index;
  if (target.repeat !== undefined && reader.repeatTopIndex === undefined && target.repeat.index === readerRepeat) return target.index < reader.location.index;
  return target.topIndex < reader.location.topIndex;
}

/** The kinds of reference, each with how it names its target. */
type ReferenceKind = "over" | "if" | "reads" | "while" | "each";

/** Why one name of one reference is not good, or undefined. */
function targetIssue(
  target: Target | undefined,
  name: string,
  kind: ReferenceKind,
  reader: ReaderPlace,
  readerId: string | undefined,
): string | undefined {
  if (target === undefined) return `names "${name}", which is no phase or agent of this workflow`;
  if (target.lastOfStream !== undefined) return `names "${name}", a phase of a stream that is not its last, so no output holds all of its items; name the last phase of the stream, "${target.lastOfStream}"`;
  if (readerId !== undefined && (target.id === readerId || target.phase.phase === readerId)) return `names "${name}", which is its own output`;
  if (kind === "while") {
    return target.location.repeat?.index === reader.repeatTopIndex ? undefined : `names "${name}", which is not a phase of the repeat's own phases`;
  }
  if (kind === "each" && target.location.repeat?.index === reader.repeatTopIndex) return `names "${name}", a phase of the repeat's own phases, which runs after the repeat reads its items; name an earlier phase`;
  if (kind === "if" && target.location.repeat !== undefined && target.location.repeat.index !== reader.location.repeat?.index) {
    return `names "${name}", a phase inside a repeat, which a phase outside the repeat cannot test; test a phase after the repeat instead`;
  }
  if (!finishesBefore(target.location, reader)) {
    return `names "${name}", which does not finish before this phase starts; phases run in order, so name an earlier phase or agent`;
  }
  return undefined;
}

/** The `<source>.<field>` that `ref` names, or why it cannot. */
function fieldRef(ref: string): { readonly source: string; readonly field: string } | string {
  try {
    return parseFieldRef(ref);
  } catch (error) {
    if (error instanceof FieldRefError) return error.message;
    throw error;
  }
}

/** Every bad reference of one workflow, each a message that names its
 *  phase, agent, or repeat. A stream phase must follow the phase it names
 *  directly, and that phase must be a phase over a list; `if` stands on no
 *  stream phase. `over`, `repeat.each`, and an `if` with a field name a
 *  field, which compilation and validation check against the output
 *  contracts. */
export function referenceIssues(workflow: Pick<WorkflowDefinition, "id" | "phases">): readonly string[] {
  const named = targets(workflow);
  const issues: string[] = [];
  const report = (where: string, key: string, issue: string | undefined): void => {
    if (issue !== undefined) issues.push(`Workflow "${workflow.id}": ${where} ${key} ${issue}`);
  };
  const judgeField = (where: string, key: string, ref: string, kind: ReferenceKind, reader: ReaderPlace, readerId: string | undefined): void => {
    const parsed = fieldRef(ref);
    if (typeof parsed === "string") return report(where, key, parsed);
    if (parsed.source === WORKFLOW_INPUT_SOURCE_ID) {
      if (kind === "if" || kind === "while") report(where, key, `names the launch input, which a phase cannot test; test an agent's output`);
      return;
    }
    report(where, key, targetIssue(named.get(parsed.source), parsed.source, kind, reader, readerId));
  };
  for (const { phase, location } of allPhases(workflow)) {
    const where = location.label;
    const reader: ReaderPlace = { location };
    if (phase.over !== undefined && isStreamOver(phase.over)) {
      const previous = previousPhase(workflow, location);
      if (phase.agents !== undefined) report(where, "over", `cannot stand beside agents; a phase holds named agents or one agent for each item, not both`);
      else if (previous?.phase !== phase.over) report(where, "over", `names "${phase.over}", but a stream phase follows the phase directly before it; name "${previous?.phase ?? "(none)"}", or name a list field as "<phase>.<field>"`);
      else if (previous.over === undefined || previous.agents !== undefined) report(where, "over", `names "${phase.over}", which is not a phase over a list; a stream phase follows a phase with over`);
      if (phase.if !== undefined) report(where, "if", `stands on a stream phase, whose agents follow the agents before them one by one; put if on the first phase of the stream`);
      if (phase.votes !== undefined) report(where, "votes", `stands on a stream phase; votes goes on the first phase of the stream and counts for every phase of it`);
    } else if (phase.over !== undefined) {
      if (phase.agents !== undefined) report(where, "over", `cannot stand beside agents; a phase holds named agents or one agent for each item, not both`);
      else judgeField(where, "over", phase.over, "over", reader, phase.phase);
    }
    if (phase.if !== undefined && !(phase.over !== undefined && isStreamOver(phase.over))) {
      if (phase.if.includes(".")) judgeField(where, "if", phase.if, "if", reader, phase.phase);
      else report(where, "if", targetIssue(named.get(phase.if), phase.if, "if", reader, phase.phase));
    }
    const head = streamHeadOf(workflow, phase) ?? phase;
    const startsAt = head === phase ? location : allPhases(workflow).find((entry) => entry.phase === head)?.location ?? location;
    const records = phase.agents === undefined ? [{ id: phase.phase, reads: phase.reads }] : namedAgents(phase).map(({ agent, reads }) => ({ id: agent, reads: reads ?? phase.reads }));
    for (const { id, reads } of records) {
      for (const name of reads ?? []) report(id === phase.phase ? where : `Agent "${id}"`, "reads", targetIssue(named.get(name), name, "reads", { location: startsAt }, id));
    }
  }
  for (const [topIndex, entry] of workflow.phases.entries()) {
    if (!isRepeat(entry)) continue;
    const where = repeatLabel(topIndex);
    const reader: ReaderPlace = { location: { index: topIndex, topIndex, label: where }, repeatTopIndex: topIndex };
    if (isWhileRepeat(entry.repeat)) judgeField(where, "while", entry.repeat.while, "while", reader, undefined);
    else {
      judgeField(where, "each", entry.repeat.each, "each", reader, undefined);
      const { reassess } = entry.repeat;
      const last = entry.phases.at(-1);
      if (reassess !== undefined && last?.phase !== reassess) report(where, "reassess", `names "${reassess}", which is not the last phase of the repeat; the reassess phase runs last in each round`);
      else if (reassess !== undefined && last !== undefined && phaseKind(last) !== "single") report(where, "reassess", `names "${reassess}", which is not a phase of one agent`);
    }
  }
  return issues;
}

/** The phase directly before one phase in its own list, or undefined. */
function previousPhase(workflow: Pick<WorkflowDefinition, "phases">, location: PhaseLocation): WorkflowPhase | undefined {
  const list = location.repeat === undefined ? workflow.phases : location.repeat.entry.phases;
  const previous = list[location.index - 1];
  return previous === undefined || isRepeat(previous) ? undefined : previous;
}

/** The first phase of the stream that holds `phase`, or undefined when no
 *  stream holds it. */
function streamHeadOf(workflow: Pick<WorkflowDefinition, "phases">, phase: WorkflowPhase): WorkflowPhase | undefined {
  return streams(workflow).find((stream) => stream.includes(phase))?.[0];
}
