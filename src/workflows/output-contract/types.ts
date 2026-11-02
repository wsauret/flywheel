import type { envelope } from "./envelope.js";
import type { CaseMap, Field, FieldMap, OutputObject } from "./grammar.js";

/** Static payload types for contracts written as TypeScript literals (plan
 *  section 2.4). Declare the contract `as const satisfies OutputObject`; then
 *  `PayloadOf<typeof contract>` is the type its compiled schema decodes to, so
 *  a reader needs no cast. A contract read from JSON at run time has the wide
 *  `OutputObject` type and gets `StepPayload`. */

type Simplify<T> = { [Key in keyof T]: T[Key] };

type BaseValueOf<F extends Field> =
  F["type"] extends "string" | "path" ? string
  : F["type"] extends "number" ? number
  : F["type"] extends "boolean" ? boolean
  : F["type"] extends "enum" ? F["values"] extends readonly (infer Value)[] ? Value : never
  : F["type"] extends "list" ? F["of"] extends Field ? readonly ValueOf<F["of"]>[] : never
  : F["type"] extends "object" ? F["fields"] extends FieldMap ? FieldsPayload<F["fields"]> : never
  : F["type"] extends "variant" ? F["tag"] extends string ? F["cases"] extends CaseMap ? VariantPayload<F["tag"], F["cases"]> : never : never
  : never;

/** The value type a field decodes to. */
export type ValueOf<F extends Field> = F extends { readonly nullable: true } ? BaseValueOf<F> | null : BaseValueOf<F>;

type RequiredKeys<M extends FieldMap> = { [Key in keyof M]: M[Key] extends { readonly optional: true } ? never : Key }[keyof M];
type OptionalKeys<M extends FieldMap> = { [Key in keyof M]: M[Key] extends { readonly optional: true } ? Key : never }[keyof M];

/** The object a closed field map decodes to. */
type FieldsPayload<M extends FieldMap> = Simplify<
  { readonly [Key in RequiredKeys<M>]: ValueOf<M[Key]> } & { readonly [Key in OptionalKeys<M>]?: ValueOf<M[Key]> }
>;

type VariantPayload<Tag extends string, Cases extends CaseMap> = {
  [Value in keyof Cases & string]: Simplify<{ readonly [Key in Tag]: Value } & FieldsPayload<Cases[Value]>>
}[keyof Cases & string];

/** One stored command-run record after the boundary filled `command`. */
export type CommandRun = ValueOf<typeof envelope.commands_run.of>;

type FieldsOf<O extends OutputObject> = O extends { readonly fields?: infer Fields } ? Exclude<Fields, undefined> : never;

/** The envelope plus the declared fields, or the envelope alone. */
type WithFields<Envelope, O extends OutputObject> = FieldsOf<O> extends FieldMap ? Simplify<Envelope & FieldsPayload<FieldsOf<O>>> : Envelope;

type InlineEnvelope<O extends OutputObject> = Simplify<
  { readonly summary: string; readonly files_modified?: readonly string[] }
  & (O extends { readonly commands: { readonly min: number } }
    ? { readonly commands_run: readonly CommandRun[] }
    : { readonly commands_run?: readonly CommandRun[] })
>;

/** The payload type of a contract whose keys are not known statically. */
export interface StepPayload {
  readonly summary: string;
  readonly [key: string]: unknown;
}

/** The decoded payload type of an output contract literal. */
export type PayloadOf<O extends OutputObject> =
  string extends keyof FieldsOf<O> ? StepPayload
  : O extends { readonly submit: "file" }
    ? WithFields<{ readonly summary: string }, O>
    : WithFields<InlineEnvelope<O>, O>;
