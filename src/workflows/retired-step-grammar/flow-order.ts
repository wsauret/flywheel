import {
  flowEntryLabel,
  flowEntryLocalId,
  flowListLabel,
  flowLists,
  walkFlow,
  type WorkflowFlowEntry,
} from "./schema.js";

/** The run order of one flow list: for each entry, the indexes of the sibling
 *  entries it runs after. An entry without `after` runs after the entry
 *  before it. `after: []` gives it no sibling prerequisite, so only its
 *  container gates it. `after: [a, b]` names siblings by local id. */
export interface SiblingOrder {
  readonly prerequisites: readonly (readonly number[])[];
  /** Located problems, one message each. A list with an issue has no
   *  defined order, so a compiler refuses it. */
  readonly issues: readonly string[];
}

interface LocatedEntry {
  readonly index: number;
  readonly explicit: boolean;
}

/** Resolve the `after` references of one flow list. `elsewhere` maps each
 *  local id of the other flow lists of the tree to that list's label, so a
 *  reference across lists reads as one and not as an unknown id. */
function resolveSiblingOrder(
  entries: readonly WorkflowFlowEntry[],
  phases: readonly string[],
  elsewhere: ReadonlyMap<string, string>,
): SiblingOrder {
  const issues: string[] = [];
  const byId = new Map<string, LocatedEntry[]>();
  for (const [index, entry] of entries.entries()) {
    const id = flowEntryLocalId(entry);
    if (id === undefined) continue;
    // Only a step entry's id can be implicit: the step id it runs.
    const explicit = !("step" in entry) || entry.id !== undefined;
    const holders = byId.get(id) ?? [];
    const repeated = holders.find((holder) => holder.explicit || explicit);
    if (repeated) {
      issues.push(`${flowEntryLabel(phases, index)} repeats id "${id}", which step ${repeated.index} of the same flow already uses; give each entry of one flow its own id`);
    }
    holders.push({ index, explicit });
    byId.set(id, holders);
  }

  const prerequisites = entries.map((entry, index): number[] => {
    if (entry.after === undefined) return index === 0 ? [] : [index - 1];
    const label = flowEntryLabel(phases, index);
    const resolved: number[] = [];
    for (const id of entry.after) {
      const holders = byId.get(id) ?? [];
      const [holder, second] = holders;
      if (holder === undefined) {
        const other = elsewhere.get(id);
        issues.push(other === undefined
          ? `${label} after names "${id}", which no entry of the same flow has`
          : `${label} after names "${id}", which is in ${other}; after names only entries of its own flow, so order work across containers with after on the containers`);
        continue;
      }
      if (holder.index === index && second === undefined) {
        issues.push(`${label} after names its own id "${id}"`);
        continue;
      }
      if (second !== undefined) {
        issues.push(`${label} after names "${id}", which steps ${holders.map(({ index: at }) => at).join(" and ")} of the same flow share; give each of them its own id`);
        continue;
      }
      if (!resolved.includes(holder.index)) resolved.push(holder.index);
    }
    return resolved.toSorted((a, b) => a - b);
  });

  for (const cycle of orderCycles(prerequisites)) {
    const names = cycle.map((index) => {
      const entry = entries[index];
      const id = entry === undefined ? undefined : flowEntryLocalId(entry);
      return id === undefined ? `step ${index}` : `"${id}"`;
    });
    issues.push(`${flowEntryLabel(phases, cycle[0] ?? 0)} is in an after cycle in ${flowListLabel(phases)}: ${names.join(" -> ")}`);
  }
  return { prerequisites, issues };
}

/** Each cycle of the prerequisite relation once, as entry indexes that start
 *  and end at the same entry. */
function orderCycles(prerequisites: readonly (readonly number[])[]): readonly (readonly number[])[] {
  const cycles: number[][] = [];
  const state = new Map<number, "visiting" | "done">();
  const stack: number[] = [];
  const visit = (index: number): void => {
    const seen = state.get(index);
    if (seen === "done") return;
    if (seen === "visiting") {
      cycles.push([...stack.slice(stack.indexOf(index)), index]);
      return;
    }
    state.set(index, "visiting");
    stack.push(index);
    for (const prerequisite of prerequisites[index] ?? []) visit(prerequisite);
    stack.pop();
    state.set(index, "done");
  };
  for (const index of prerequisites.keys()) visit(index);
  return cycles;
}

/** Resolve the run order of every flow list of an authored tree, keyed by
 *  the list. Validation reports every issue; a compiler refuses the first. */
export function resolveFlowOrder(
  flow: readonly WorkflowFlowEntry[],
): ReadonlyMap<readonly WorkflowFlowEntry[], SiblingOrder> {
  const lists = flowLists(flow);
  const orders = new Map<readonly WorkflowFlowEntry[], SiblingOrder>();
  for (const { entries, phases } of lists) {
    const own = new Set(entries.flatMap((entry) => {
      const id = flowEntryLocalId(entry);
      return id === undefined ? [] : [id];
    }));
    const elsewhere = new Map<string, string>();
    walkFlow(flow, (entry, location) => {
      const id = flowEntryLocalId(entry);
      if (id === undefined || own.has(id) || elsewhere.has(id)) return;
      if (location.phases.join("/") === phases.join("/")) return;
      elsewhere.set(id, flowListLabel(location.phases));
    });
    orders.set(entries, resolveSiblingOrder(entries, phases, elsewhere));
  }
  return orders;
}
