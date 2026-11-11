import { Result, Schema } from "effect";
import { isRecord, type UnknownRecord } from "../../infra/record.js";
import { schemaIssues } from "./accept.js";
import { fieldSchema, type CompiledOutput } from "./compile.js";
import type { Field } from "./grammar.js";
import { declaredPayload, walkValue } from "./leniency.js";
import type { OutputIssue } from "./paths.js";

// The salvage of a handoff that the runtime delivers after its correction
// ran out. A formatting error never throws the work away, and a phase over a
// list or a join almost never breaks because a list it needs could not be
// read. The handoff tool already made every repair whose meaning is clear
// (refer to `handoffToolSchemaFromOutput`), so salvage only selects items.

/** The problems of one value as a declared field decodes it, with only its
 *  declared keys; empty when it decodes. */
function decodeIssues(field: Field, value: unknown): readonly OutputIssue[] {
  const declared = walkValue(field, value, "", (fields, record) => declaredPayload(fields, record).payload);
  const decoded = Schema.decodeUnknownResult(fieldSchema(field), { errors: "all" })(declared);
  return Result.isSuccess(decoded) ? [] : schemaIssues(decoded.failure.issue);
}

/** The items of one structural list of a delivered handoff that the
 *  workflow can run: each item that the item contract cannot read, or that
 *  repeats the `unique` key of an earlier item, is left out. With `cut`, so
 *  is each item after the declared `max`, because a phase over the list or
 *  a join reads at most `max` items. Each item left out has an issue that
 *  holds the whole item, so the parent keeps it. */
function salvageList(key: string, field: Field, list: readonly unknown[], cut: boolean, issues: OutputIssue[]): unknown[] {
  const kept: unknown[] = [];
  const keys = new Set<unknown>();
  const leaveOut = (index: number, item: unknown, because: string): void => {
    issues.push({ path: `${key}.${index}`, message: `the item was left out because ${because}`, hint: `item: ${JSON.stringify(item)}` });
  };
  for (const [index, item] of list.entries()) {
    const problems = field.of === undefined ? [] : decodeIssues(field.of, item);
    if (problems.length > 0) {
      leaveOut(index, item, problems.map((issue) => `${issue.path === "(root)" ? "it" : issue.path}: ${issue.message}`).join("; "));
      continue;
    }
    const unique = field.unique === undefined || !isRecord(item) ? undefined : item[field.unique];
    if (unique !== undefined && keys.has(unique)) {
      leaveOut(index, item, `an earlier item has the same "${field.unique}"`);
      continue;
    }
    if (cut && field.max !== undefined && kept.length >= field.max) {
      leaveOut(index, item, `the list holds at most ${field.max} items`);
      continue;
    }
    if (unique !== undefined) keys.add(unique);
    kept.push(item);
  }
  return kept;
}

/** The list fields of a delivered handoff that the workflow's structure
 *  reads: `counted` lists bound a worst-case count, so salvage cuts them to
 *  their `max`; `admitted` lists are read by a join's admission. */
export interface StructuralListKeys {
  readonly counted: readonly string[];
  readonly admitted: readonly string[];
}

/** A delivered handoff after salvage, and an issue for each item it left out. */
export interface SalvagedHandoff {
  readonly payload: UnknownRecord;
  readonly issues: readonly OutputIssue[];
}

/** A delivered handoff with each structural list salvaged (refer to
 *  {@link salvageList}). A structural value that is no list holds no item
 *  the workflow can read, so it becomes an empty list with an issue that
 *  holds the value. An absent list stays absent, because salvage invents no
 *  value. Every other field stays as the agent sent it. */
export function salvageDelivered(output: Pick<CompiledOutput, "payloadFields">, payload: UnknownRecord, lists: StructuralListKeys): SalvagedHandoff {
  const issues: OutputIssue[] = [];
  const salvaged: UnknownRecord = { ...payload };
  const counted = new Set(lists.counted);
  for (const key of new Set([...lists.counted, ...lists.admitted])) {
    const field = output.payloadFields[key];
    const value = salvaged[key];
    if (field?.type !== "list" || value === undefined || (value === null && field.nullable === true)) continue;
    if (Array.isArray(value)) {
      salvaged[key] = salvageList(key, field, value, counted.has(key), issues);
    } else {
      issues.push({ path: key, message: "the value is not a list, so it was read as an empty list", hint: `value: ${JSON.stringify(value)}` });
      salvaged[key] = [];
    }
  }
  return { payload: salvaged, issues };
}
