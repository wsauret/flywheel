import { compileOutput, type CompiledOutput } from "../output-contract/compile.js";
import type { Field, OutputObject } from "../output-contract/grammar.js";
import type { PayloadOf } from "../output-contract/types.js";

/** The output contract of the agent of a repeat's `reassess` phase. The VM
 *  owns it: the brief declares no output, and the compiler fills the item
 *  shape from the declared item type of the repeat's `each` source, so a
 *  replacement or inserted item is run exactly like an item the source
 *  wrote. An empty `changes` list confirms the remaining items. */
function reassessmentContract<const Item extends Field>(item: Item) {
  const itemId = { type: "string", description: "The id of a remaining item for drop and replace, or of the remaining or just-completed item after which insert adds the new item." } as const;
  const replacement = { ...item, description: "The new or replacement item, in the same shape as the other items." } as const;
  return {
    summary: "Why the remaining items stay as they are or change, and what evidence from the completed round drove that decision.",
    fields: {
      changes: {
        type: "list",
        description: "Changes to the REMAINING items only. Empty when the remaining items stay unchanged, which is the default; change them only with concrete evidence. Each change: { action (\"drop\" | \"replace\" | \"insert\"), item_id (the remaining-item id for drop/replace, or the remaining/just-completed anchor id for insert), item (the new/replacement item, required for replace/insert) }. Completed items are immutable.",
        of: {
          type: "variant",
          tag: "action",
          cases: {
            drop: { item_id: itemId },
            replace: { item_id: itemId, item: replacement },
            insert: { item_id: itemId, item: replacement },
          },
        },
      },
    },
  } as const satisfies OutputObject;
}

/** The item fields the VM reads. An item is an object whose `id` names it;
 *  definition validation proves that every `each` source a `reassess` phase
 *  reads declares that key, so the static type states only that key. */
const itemIdentity = { type: "object", fields: { id: { type: "string", description: "The item id." } } } as const satisfies Field;

/** The decoded payload of a reassessment agent. */
export type ReassessmentPayload = PayloadOf<ReturnType<typeof reassessmentContract<typeof itemIdentity>>>;

/** Compile the reassessment contract for the item type of one `each`
 *  source. */
export function compileReassessmentOutput(item: Field): CompiledOutput<ReassessmentPayload> {
  return compileOutput(reassessmentContract(item));
}

/** The frozen contract of the `reassess` agent of a `for` node of control
 *  from before phases, which named each item a phase. A paused run of such
 *  a node resumes its reassess attempt with this contract, which strict
 *  replay and the attempt's handoff read. Remove after 2027-04-30. */
function retiredReassessmentContract<const Item extends Field>(item: Item) {
  const phaseId = { type: "string", description: "The id of a remaining phase for drop and replace, or of the remaining or just-completed phase after which insert adds the new phase." } as const;
  const phase = { ...item, description: "The new or replacement phase, in the same shape as the phases of the plan." } as const;
  return {
    summary: "Why the remaining phases stay as they are or change, and what evidence from the completed phase drove that decision.",
    fields: {
      changes: {
        type: "list",
        description: "Re-spec to REMAINING phases only. Empty when the remaining phases stay unchanged, which is the default; change them only with concrete evidence. Each change: { action (\"drop\" | \"replace\" | \"insert\"), phase_id (the remaining-phase id for drop/replace, or the remaining/just-completed anchor id for insert), phase (the new/replacement phase object, required for replace/insert) }. Completed phases are immutable.",
        of: {
          type: "variant",
          tag: "action",
          cases: {
            drop: { phase_id: phaseId },
            replace: { phase_id: phaseId, phase },
            insert: { phase_id: phaseId, phase },
          },
        },
      },
    },
  } as const satisfies OutputObject;
}

const phaseIdentity = { type: "object", fields: { id: { type: "string", description: "The phase id." } } } as const satisfies Field;

/** The decoded payload of the reassess agent of a `for` node of control from
 *  before phases. Remove after 2027-04-30. */
export type RetiredReassessmentPayload = PayloadOf<ReturnType<typeof retiredReassessmentContract<typeof phaseIdentity>>>;

/** Compile the frozen reassessment contract of a `for` node of control from
 *  before phases. Remove after 2027-04-30. */
export function compileRetiredReassessmentOutput(item: Field): CompiledOutput<RetiredReassessmentPayload> {
  return compileOutput(retiredReassessmentContract(item));
}
