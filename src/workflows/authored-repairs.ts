/** The repairs that the workflow reader makes to an authored document before
 *  it decodes the document strictly.
 *
 *  A workflow file is an external boundary: a model or a person wrote it.
 *  Some mistakes have exactly one reading, so the reader normalizes them
 *  once into the canonical shape and reports each change, as a tool argument
 *  repair does. Each repair below is one of those mistakes:
 *
 *  - An unquoted comma in a flow mapping, such as
 *    `{ type: string, description: The defect, in one sentence. }`, makes
 *    YAML read the text after the comma as a key with no value. In a field
 *    or an output contract, such a key that is not a grammar key, right
 *    after the text, is rejoined only when the source contains that text
 *    with the comma.
 *  - A `description` on a list item (`of`) describes the items. The list
 *    takes it when the list has no description of its own.
 *  - A declared output field `summary` of type string describes the
 *    envelope summary, or restates it when it states no description, and a
 *    declared `files_modified` list of strings or paths restates an envelope
 *    key that every handoff carries.
 *  - A `join: { reducer: collect }` with no other key, on a phase of named
 *    agents or on the last phase of a stream, restates the default join.
 *    The same join on a phase of one agent, or on a phase that a stream
 *    phase follows, stands in the wrong place, so it stays.
 *  - In a file in the retired step grammar, `reads` on a flow entry moves to
 *    the retired record that the entry runs (refer to
 *    `retired-step-grammar/flow-reads.ts`, which carries its removal date).
 *
 *  Anything with another reading stays as written, so strict decoding
 *  refuses it. Each repair is deterministic, so a run that rebuilds the file
 *  from its text reads the same definition. */

import { moveRetiredFlowReads } from "./retired-step-grammar/flow-reads.js";

/** One mapping of the parsed YAML, before any schema reads it. */
interface RawNode {
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is RawNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One change that the reader made, located at its key path. */
export interface AuthoredRepair {
  readonly keyPath: string;
  readonly message: string;
}

const FIELD_KEYS = new Set(["type", "description", "example", "optional", "nullable", "values", "exists", "min", "max", "unique", "tag", "of", "fields", "cases"]);
const OUTPUT_KEYS = new Set(["summary", "commands", "submit", "fields"]);

function normalizeTextWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").replace(/\s*,\s*/gu, ",");
}

/** `node` with each key that a comma split off its text joined back to the
 *  text under `textKey`. */
function rejoinSplitText(node: RawNode, textKey: string, grammarKeys: ReadonlySet<string>, at: string, repairs: AuthoredRepair[], sourceText: string): RawNode {
  const kept: [string, unknown][] = [];
  let joined = false;
  for (const [key, value] of Object.entries(node)) {
    const last = kept.at(-1);
    if (value === null && !grammarKeys.has(key) && last?.[0] === textKey && typeof last[1] === "string") {
      const text = `${last[1]}, ${key}`;
      if (sourceText.includes(normalizeTextWhitespace(text))) {
        last[1] = text;
        joined = true;
      } else {
        kept.push([key, value]);
      }
    } else {
      kept.push([key, value]);
    }
  }
  if (!joined) return node;
  const repaired = Object.fromEntries(kept);
  repairs.push({
    keyPath: `${at}.${textKey}`,
    message: `an unquoted comma split this text in a YAML flow mapping, so Flywheel rejoined it as ${JSON.stringify(repaired[textKey])}; quote a text value that holds a comma`,
  });
  return repaired;
}

/** `list` with the description of its item moved to the list, or dropped
 *  when the list states its own. */
function repairItem(list: RawNode, at: string, repairs: AuthoredRepair[], sourceText: string): RawNode {
  if (!isNode(list.of)) return list;
  const item = repairField(list.of, `${at}.of`, repairs, sourceText);
  if (typeof item.description !== "string") return { ...list, of: item };
  const { description, ...rest } = item;
  const moved = list.description === undefined;
  repairs.push({
    keyPath: `${at}.of.description`,
    message: moved
      ? "a list item takes no description, so Flywheel moved it to the list; describe the list instead"
      : "a list item takes no description, so Flywheel dropped it and kept the description of the list; describe the list instead",
  });
  return { ...list, ...(moved ? { description } : {}), of: rest };
}

function repairField(field: RawNode, at: string, repairs: AuthoredRepair[], sourceText: string): RawNode {
  const node = repairItem(rejoinSplitText(field, "description", FIELD_KEYS, at, repairs, sourceText), at, repairs, sourceText);
  const { fields, cases } = node;
  return {
    ...node,
    ...(isNode(fields) ? { fields: repairFieldMap(fields, `${at}.fields`, repairs, sourceText) } : {}),
    ...(isNode(cases) ? { cases: Object.fromEntries(Object.entries(cases).map(([value, caseFields]) => [value, isNode(caseFields) ? repairFieldMap(caseFields, `${at}.cases.${value}`, repairs, sourceText) : caseFields])) } : {}),
  };
}

function repairFieldMap(fields: RawNode, at: string, repairs: AuthoredRepair[], sourceText: string): RawNode {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, isNode(field) ? repairField(field, `${at}.${key}`, repairs, sourceText) : field]));
}

/** An agent record's output contract with its fields repaired and each envelope key
 *  that a field restates moved or dropped. */
function repairOutput(contract: RawNode, at: string, repairs: AuthoredRepair[], sourceText: string): RawNode {
  const output = rejoinSplitText(contract, "summary", OUTPUT_KEYS, at, repairs, sourceText);
  if (!isNode(output.fields)) return output;
  const { summary, files_modified: filesModified, ...rest } = repairFieldMap(output.fields, `${at}.fields`, repairs, sourceText);
  // Only a list of paths restates the envelope's file list; any other
  // declaration stays for the strict decode to refuse.
  const restatesEnvelope = isNode(filesModified) && filesModified.type === "list" && isNode(filesModified.of) && (filesModified.of.type === "string" || filesModified.of.type === "path");
  if (restatesEnvelope) repairs.push({ keyPath: `${at}.fields.files_modified`, message: "files_modified is a key of the handoff envelope, which every handoff carries, so Flywheel dropped this field" });
  const fields = restatesEnvelope || filesModified === undefined ? rest : { ...rest, files_modified: filesModified };
  if (!isNode(summary) || summary.type !== "string" || !(summary.description === undefined || typeof summary.description === "string")) {
    return { ...output, fields: summary === undefined ? fields : { ...fields, summary } };
  }
  const moved = output.summary === undefined && summary.description !== undefined;
  const message = moved
    ? "summary is a key of the handoff envelope, so Flywheel read this field as the top-level summary of the output; describe it there"
    : output.summary === undefined
      ? "summary is a key of the handoff envelope, which every handoff carries, so Flywheel dropped this field"
      : "summary is a key of the handoff envelope, so Flywheel dropped this field and kept the top-level summary of the output";
  repairs.push({ keyPath: `${at}.fields.summary`, message });
  return { ...output, ...(moved ? { summary: summary.description } : {}), fields };
}

/** One agent record with its output contract repaired. */
function repairRecord(record: RawNode, at: string, repairs: AuthoredRepair[], source: string): RawNode {
  return isNode(record.output) ? { ...record, output: repairOutput(record.output, `${at}.output`, repairs, source) } : record;
}

/** `phase` without a join that restates the default join. A phase of named
 *  agents, and a phase over a list that the next phase does not stream
 *  from, join with `collect` by default. */
function withoutDefaultJoin(phase: RawNode, next: unknown, at: string, repairs: AuthoredRepair[]): RawNode {
  const { join, ...rest } = phase;
  const bareCollect = isNode(join) && Object.keys(join).length === 1 && join.reducer === "collect";
  const collectsByDefault = Array.isArray(phase.agents) || (typeof phase.over === "string" && !(isNode(next) && next.over === phase.phase));
  if (!bareCollect || !collectsByDefault) return phase;
  repairs.push({ keyPath: `${at}.join`, message: "a phase of named agents and the last phase of a stream join with collect by default, so Flywheel dropped this join; remove join" });
  return rest;
}

/** One `phases` list, top-level or of a repeat, with each element repaired. */
function repairPhaseList(list: readonly unknown[], at: string, repairs: AuthoredRepair[], source: string): unknown[] {
  return list.map((entry, index) => isNode(entry) ? repairPhaseOrRepeat(entry, list[index + 1], `${at}.${index}`, repairs, source) : entry);
}

/** One element of a `phases` list: a phase with its join, its own record,
 *  and each named agent's record repaired, or a repeat with each of its
 *  phases. `next` is the element that follows it in its list. */
function repairPhaseOrRepeat(entry: RawNode, next: unknown, at: string, repairs: AuthoredRepair[], source: string): RawNode {
  if (Array.isArray(entry.phases)) return { ...entry, phases: repairPhaseList(entry.phases, `${at}.phases`, repairs, source) };
  const phase = repairRecord(withoutDefaultJoin(entry, next, at, repairs), at, repairs, source);
  if (!Array.isArray(phase.agents)) return phase;
  return { ...phase, agents: phase.agents.map((agent, index) => isNode(agent) ? repairRecord(agent, `${at}.agents.${index}`, repairs, source) : agent) };
}

/** A parsed workflow document after its repairs, with each repair. */
export interface RepairedDocument {
  readonly document: RawNode;
  readonly repairs: readonly AuthoredRepair[];
}

/** Repair one parsed workflow document (refer to the module comment). The
 *  document is the parsed YAML after the retired keys left it. Source text
 *  establishes comma splits; an empty source permits no comma repairs. */
export function repairAuthoredDocument(document: RawNode, sourceText: string): RepairedDocument {
  const repairs: AuthoredRepair[] = [];
  const source = normalizeTextWhitespace(sourceText);
  const { input, steps: retiredRecords, flow, phases } = document; // retired key of the step grammar
  // An input contract declares only fields, so no envelope key moves.
  const repairedInput = isNode(input) && isNode(input.fields) ? { input: { ...input, fields: repairFieldMap(input.fields, "input.fields", repairs, source) } } : {};
  if (Array.isArray(phases)) {
    const repairedPhases = repairPhaseList(phases, "phases", repairs, source);
    return repairs.length === 0 ? { document, repairs } : { document: { ...document, ...repairedInput, phases: repairedPhases }, repairs };
  }
  if (!isNode(retiredRecords)) return repairs.length === 0 ? { document, repairs } : { document: { ...document, ...repairedInput }, repairs };
  const outputs = Object.fromEntries(Object.entries(retiredRecords).map(([id, record]) => [
    id,
    isNode(record) && isNode(record.output) ? { ...record, output: repairOutput(record.output, `steps.${id}.output`, repairs, source) } : record, // retired key path
  ]));
  const reads = moveRetiredFlowReads(outputs, flow, repairs);
  if (repairs.length === 0) return { document, repairs };
  return { document: { ...document, ...repairedInput, ...reads }, repairs };
}
