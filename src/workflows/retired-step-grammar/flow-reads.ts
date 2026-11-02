/** The repair of `reads` on a flow entry of a file in the retired step
 *  grammar (refer to `authored-repairs.ts`). `reads` on a flow entry names
 *  what the step of that entry reads. When one step entry or one map over
 *  one step runs that step, and nothing else runs it, the step record takes
 *  it. The loader repairs such a file before it converts the file to
 *  phases, so the conversion moves the reads to the phase of that step.
 *
 *  Remove after 2027-04-30, with the conversion. */
import type { AuthoredRepair } from "../authored-repairs.js";

/** One mapping of the parsed YAML, before any schema reads it. */
interface RawNode {
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is RawNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many places in `flow` name each step: a step entry, each step of a
 *  `do`, and each `then` or `reassess` step, at any depth. */
function stepUses(flow: unknown, uses = new Map<string, number>()): Map<string, number> {
  const use = (id: unknown): void => {
    if (typeof id === "string") uses.set(id, (uses.get(id) ?? 0) + 1);
  };
  if (Array.isArray(flow)) for (const entry of flow) stepUses(entry, uses);
  if (!isNode(flow)) return uses;
  use(flow.step);
  use(flow.reassess);
  if (typeof flow.then === "string") use(flow.then);
  else stepUses(flow.then, uses);
  if (Array.isArray(flow.do)) for (const id of flow.do) use(id);
  else if (typeof flow.do === "string") use(flow.do);
  else stepUses(flow.do, uses);
  stepUses(flow.flow, uses);
  return uses;
}

/** The one step that a flow entry with `reads` runs, or undefined when the
 *  entry runs none or several. */
function readingStep(entry: RawNode): string | undefined {
  if (typeof entry.step === "string") return entry.step;
  if (typeof entry.map !== "string") return undefined;
  if (typeof entry.do === "string") return entry.do;
  return Array.isArray(entry.do) && entry.do.length === 1 && typeof entry.do[0] === "string" ? entry.do[0] : undefined;
}

interface FlowRepair {
  readonly flow: readonly unknown[];
  /** The ids that each step takes from the flow entries that ran it. */
  readonly reads: ReadonlyMap<string, readonly string[]>;
}

/** `flow` with each `reads` that one step owns moved out. A phase holds a
 *  flow of its own. */
function moveFlowReads(flow: readonly unknown[], at: string, steps: RawNode, uses: ReadonlyMap<string, number>, repairs: AuthoredRepair[]): FlowRepair {
  const reads = new Map<string, readonly string[]>();
  const take = (step: string, ids: readonly string[]): void => {
    reads.set(step, [...(reads.get(step) ?? []), ...ids]);
  };
  const entries = flow.map((entry, index) => {
    if (!isNode(entry)) return entry;
    const path = `${at}.${index}`;
    const inner = Array.isArray(entry.flow) ? moveFlowReads(entry.flow, `${path}.flow`, steps, uses, repairs) : undefined;
    for (const [step, ids] of inner?.reads ?? []) take(step, ids);
    const node = inner === undefined ? entry : { ...entry, flow: inner.flow };
    const step = readingStep(node);
    const { reads: ids, ...rest } = node;
    if (step === undefined || uses.get(step) !== 1 || !isNode(steps[step]) || !Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return node;
    const held = steps[step].reads;
    if (held !== undefined && (!Array.isArray(held) || !held.every((id) => typeof id === "string"))) return node;
    take(step, ids);
    repairs.push({ keyPath: `${path}.reads`, message: `reads is a key of the step record in the retired step grammar, so Flywheel moved it to steps.${step}.reads; rewrite the file in the phase grammar` });
    return rest;
  });
  return { flow: entries, reads };
}

/** The `steps` of a step-grammar document with each `reads` that one step
 *  owns moved from `flow` into its record, and the `flow` without them. A
 *  document whose flow holds no such `reads` keeps its flow. */
export function moveRetiredFlowReads(steps: RawNode, flow: unknown, repairs: AuthoredRepair[]) {
  const moved = Array.isArray(flow) ? moveFlowReads(flow, "flow", steps, stepUses(flow), repairs) : undefined;
  const repairedSteps = Object.fromEntries(Object.entries(steps).map(([id, step]) => {
    const ids = moved?.reads.get(id);
    if (ids === undefined || !isNode(step)) return [id, step];
    const held = Array.isArray(step.reads) ? step.reads : [];
    return [id, { ...step, reads: [...held, ...ids.filter((read) => !held.includes(read))] }];
  }));
  return { steps: repairedSteps, ...(moved && moved.reads.size > 0 ? { flow: moved.flow } : {}) };
}
