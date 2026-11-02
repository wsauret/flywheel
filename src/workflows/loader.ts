import { Schema } from "effect";
import type { DefinitionProvenance } from "./definition-provenance.js";
import type { WorkflowDefinition } from "./workflow-schema.js";
import { WorkflowDefinitionSchema } from "./workflow-schema.js";
import type { SkillRegistryRevision } from "./skill-schema.js";
import { definitionAssets, type AssetLocation, type DefinitionAssetReader } from "./definition-assets.js";
import { loadBriefs, loadWorkflowInputContract } from "./brief.js";
import { convertRetiredWorkflow, type RetiredWorkflowConversion } from "./retired-bindings.js";
import { convertStepGrammar, isStepGrammarDocument, type StepGrammarConversion } from "./retired-step-grammar/convert.js";
import { repairAuthoredDocument, type AuthoredRepair } from "./authored-repairs.js";
import { errorMessage } from "../infra/error-message.js";

/** A workflow file is an external boundary, so a key Flywheel once read and no
 *  longer does is dropped rather than refused: `development-only` meant the
 *  definition belonged to Flywheel's own tooling, which the development module
 *  now owns outright (ARCH-STRUCTURE-013), and the keys `selfReview`, `toolScoping`, and
 *  `kind` of a retired record switched a handoff review pass, narrowed its
 *  tools, and chose its system prompt, which are now the same for every
 *  agent (ARCH-CONTEXT-018). A file that still states one of them means nothing
 *  different from one that does not. The file still earns one warning that
 *  names each dropped key, because its author expected the key to act. */
type RawDocument = { readonly [key: string]: unknown };

function isDocument(value: unknown): value is RawDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode one authored workflow document as the loader reads it: a retired
 *  form converted, retired keys dropped, every other key strict. Anything
 *  that rewrites a workflow file validates its output through this, so it
 *  accepts exactly what loads. */
export function decodeAuthoredWorkflow(document: unknown): typeof WorkflowDefinitionSchema.Type {
  // This object-only boundary has no source evidence for comma repairs.
  return decodeStrict(normalizeAuthoredDocument(document, "").document);
}

/** Attach to one decoded definition what its files hold: the briefs, their
 *  output contracts, and the input contract, read once from `location`.
 *  A published revision never reads them again, so an edit lands only
 *  through a reload. `stepGrammar` is what the definition keeps of the file in
 *  the retired grammar that it was converted from. Throws an AggregateError
 *  with one error for each agent and for the input that failed to load,
 *  each naming the file or agent at fault. */
export function withLoadedContent(definition: typeof WorkflowDefinitionSchema.Type, input: {
  readonly location: AssetLocation | undefined;
  readonly reader: DefinitionAssetReader;
  readonly provenance: DefinitionProvenance;
  readonly stepGrammar?: StepGrammarConversion["view"];
}): WorkflowDefinition {
  // Brief loading reads the provenance: a workflow file's counted lists
  // take a default `max` (refer to `loadBriefs`), and the view of the
  // retired grammar: a converted file runs the same briefs.
  const workflow: WorkflowDefinition = {
    ...definition,
    provenance: input.provenance,
    ...(input.stepGrammar === undefined ? {} : { retiredStepGrammar: input.stepGrammar }),
  };
  const errors: unknown[] = [];
  const attempt = <T>(load: () => T): T | undefined => {
    try {
      return load();
    } catch (error) {
      errors.push(...(error instanceof AggregateError ? error.errors : [error]));
      return undefined;
    }
  };
  const inputContract = attempt(() => loadWorkflowInputContract(workflow, input.location, input.reader));
  const loaded = attempt(() => loadBriefs(workflow, input.location, input.reader, inputContract ?? null));
  // Every agent and the input load, so one refusal names each of them.
  if (loaded === undefined || inputContract === undefined) throw new AggregateError(errors, errors.map(errorMessage).join("\n"));
  return { ...workflow, briefs: loaded.briefs, inputContract };
}

/** Rebuild the definition that a run recorded at launch. A run launched
 *  before phases recorded the record of the retired grammar, and a run
 *  launched from a converted file stores that retired record beside the
 *  phase record; each converts here exactly as the loader converted the file, so
 *  the run reads the same inline briefs.
 *  Throws when the record does not decode or an agent cannot load its
 *  brief. Remove the arm of the retired grammar after 2027-04-30. */
export function recordedWorkflow(record: unknown, stepGrammarRecord: unknown, provenance: DefinitionProvenance): WorkflowDefinition {
  const stepGrammar = isDocument(stepGrammarRecord)
    ? convertStepGrammar(stepGrammarRecord)
    : isDocument(record) && isStepGrammarDocument(record) ? convertStepGrammar(record) : undefined;
  const document = stepGrammar?.document ?? record;
  // Stored v8 file runs carry catalog keys. Remove after 2027-04-30.
  const definition = decodeStrict(isDocument(document) ? withoutRetiredKeys(document).document : document);
  return withLoadedContent(definition, {
    location: undefined,
    reader: definitionAssets,
    provenance,
    ...(stepGrammar === undefined ? {} : { stepGrammar: stepGrammar.view }),
  });
}

/** One parsed workflow document after the loader's boundary rules, before
 *  the schema decodes it: a saved file in the retired bindings form is
 *  converted to the step grammar, retired keys are dropped, each mistake
 *  with one reading is repaired (refer to `authored-repairs.ts`), and a file
 *  in the retired step grammar is converted to phases. The one-file pipeline
 *  (`workflow-file.ts`) decodes the result with located issues, so it
 *  accepts exactly what the registry loads. Throws a message when a retired
 *  form cannot convert. */
export interface NormalizedAuthoredDocument {
  readonly document: unknown;
  readonly conversion?: RetiredWorkflowConversion;
  /** The conversion of the file, when the file states the retired step
   *  grammar. */
  readonly stepGrammar?: StepGrammarConversion;
  /** The key path of each dropped key, such as `development-only` or the
   *  retired `steps.review.selfReview`. */
  readonly retiredKeys: readonly string[];
  /** Each change that a repair made, located at its key path. */
  readonly repairs: readonly AuthoredRepair[];
}

export function normalizeAuthoredDocument(raw: unknown, sourceText: string, skills?: SkillRegistryRevision): NormalizedAuthoredDocument {
  if (!isDocument(raw)) return { document: raw, retiredKeys: [], repairs: [] };
  const conversion = convertRetiredWorkflow(raw, skills);
  const { document: current, retiredKeys } = withoutRetiredKeys(conversion?.document ?? raw);
  const { document: repaired, repairs } = repairAuthoredDocument(current, sourceText);
  const stepGrammar = isStepGrammarDocument(repaired) ? convertStepGrammar(repaired, conversion?.bindings, conversion?.contentIds) : undefined;
  return {
    document: stepGrammar?.document ?? repaired,
    retiredKeys,
    repairs,
    ...(conversion ? { conversion } : {}),
    ...(stepGrammar ? { stepGrammar } : {}),
  };
}

function decodeStrict(document: unknown): typeof WorkflowDefinitionSchema.Type {
  return Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "error", errors: "all" })(document);
}

interface RetiredKeyRemoval {
  readonly document: RawDocument;
  readonly retiredKeys: readonly string[];
}

/** The record keys of the retired grammar that Flywheel no longer reads. */
const RETIRED_STEP_KEYS: ReadonlySet<string> = new Set(["selfReview", "toolScoping", "kind"]);

/** Catalog keys stopped acting when workflows became file-only.
 *  Remove after 2027-04-30. */
const RETIRED_WORKFLOW_KEYS: ReadonlySet<string> = new Set(["development-only", "use_when", "confirmation_template", "requires_description", "user-invocable", "disable-model-invocation"]);

function withoutRetiredKeys(raw: RawDocument): RetiredKeyRemoval {
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => !RETIRED_WORKFLOW_KEYS.has(key)));
  const retiredKeys = Object.keys(raw).filter((key) => RETIRED_WORKFLOW_KEYS.has(key));
  const retiredRecords = rest.steps; // retired key of the step grammar
  if (!isDocument(retiredRecords)) return { document: rest, retiredKeys };
  const records = Object.fromEntries(Object.entries(retiredRecords).map(([id, record]) => {
    if (!isDocument(record)) return [id, record];
    retiredKeys.push(...Object.keys(record).filter((key) => RETIRED_STEP_KEYS.has(key)).map((key) => `steps.${id}.${key}`)); // retired key path
    return [id, Object.fromEntries(Object.entries(record).filter(([key]) => !RETIRED_STEP_KEYS.has(key)))];
  }));
  return { document: { ...rest, steps: records }, retiredKeys }; // retired key of the step grammar
}

/** One module's definition bundle: a directory holding `workflows/` and
 *  `skills/`, loaded as bundled definitions that carry the bundle id so
 *  availability can require the owning module (ARCH-STRUCTURE-031). */
export interface DefinitionBundle {
  readonly id: string;
  readonly root: string;
}


