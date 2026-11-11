import { isRecord, type UnknownRecord } from "../../infra/record.js";
import type { Field, FieldMap } from "./grammar.js";

// How the output boundary reads a submission beyond the strict contract. An
// optional string sent empty is absent, and a key the contract does not
// declare is kept beside the declared ones. A strict reader of a payload
// reads only its declared keys ({@link declaredPayload}).

/** The fields of one value of `field` that a record can hold: an object's
 *  fields, or the fields of the variant case that its tag names, with the
 *  tag. Undefined for any other field, or a variant whose tag names no case. */
function recordFields(field: Field, value: UnknownRecord): FieldMap | undefined {
  if (field.type === "object") return field.fields ?? {};
  if (field.type !== "variant" || field.tag === undefined) return undefined;
  const tag = value[field.tag];
  const fields = typeof tag === "string" ? field.cases?.[tag] : undefined;
  return fields === undefined ? undefined : { [field.tag]: { type: "string" }, ...fields };
}

function joined(at: string, key: string | number): string {
  return at === "" ? String(key) : `${at}.${key}`;
}

/** `value` read as the declared `field` with `visit` applied to each record
 *  of the declared shape, at any depth. A value of another shape stays as it
 *  is, for the strict decode to report. */
export function walkValue(field: Field, value: unknown, at: string, visit: (fields: FieldMap, record: UnknownRecord, at: string) => UnknownRecord): unknown { // oxlint-disable-line anti-slop/no-unknown-returns -- boundary: a payload value is whatever the agent sent, and the strict decode reads it next.
  if (field.type === "list" && field.of !== undefined && Array.isArray(value)) {
    const item = field.of;
    return value.map((entry, index) => walkValue(item, entry, joined(at, index), visit));
  }
  if (!isRecord(value)) return value;
  const fields = recordFields(field, value);
  return fields === undefined ? value : visit(fields, value, at);
}

/** A record with `keep` deciding each key, and each declared value walked
 *  again. */
function walkRecord(
  fields: FieldMap,
  record: UnknownRecord,
  at: string,
  keep: (key: string, field: Field | undefined, value: unknown, path: string) => boolean,
): UnknownRecord {
  const result: UnknownRecord = {};
  for (const [key, value] of Object.entries(record)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    const path = joined(at, key);
    if (!keep(key, field, value, path)) continue;
    result[key] = field === undefined ? value : walkValue(field, value, path, (inner, nested, innerAt) => walkRecord(inner, nested, innerAt, keep));
  }
  return result;
}

/** The payload without each optional field that holds only whitespace, at
 *  any depth, and the path of each one it left out. A required field keeps
 *  its empty string, which the strict decode refuses. */
/** A payload read leniently, with the path of each key the read left out. */
export interface LenientPayload {
  readonly payload: UnknownRecord;
  readonly dropped: readonly string[];
}

export function withoutEmptyOptionals(fields: FieldMap, payload: UnknownRecord): LenientPayload {
  const dropped: string[] = [];
  const kept = walkRecord(fields, payload, "", (_key, field, value, path) => {
    const empty = field?.optional === true && typeof value === "string" && value.trim() === "";
    if (empty) dropped.push(path);
    return !empty;
  });
  return { payload: kept, dropped };
}

/** A payload's declared keys, with the path of each key it left out. */
export interface DeclaredPayload {
  readonly payload: UnknownRecord;
  readonly undeclared: readonly string[];
}

/** The payload with only the keys that the contract declares, at any depth,
 *  and the path of each key it left out. A strict reader decodes this
 *  projection, so a kept undeclared key never fails it. */
export function declaredPayload(fields: FieldMap, payload: UnknownRecord): DeclaredPayload {
  const undeclared: string[] = [];
  const kept = walkRecord(fields, payload, "", (_key, field, _value, path) => {
    if (field === undefined) undeclared.push(path);
    return field !== undefined;
  });
  return { payload: kept, undeclared };
}
