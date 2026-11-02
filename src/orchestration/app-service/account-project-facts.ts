import { Schema } from "effect"

import { defineFact } from "../../infra/event-registry.js"

const KnownAccountProjectPayload = Schema.Struct({
  status: Schema.Literal("known"),
  projectRoot: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  lastAttachedAt: Schema.Number,
})

const ForgottenAccountProjectPayload = Schema.Struct({
  status: Schema.Literal("forgotten"),
  projectRoot: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
})

const AccountProjectRegistrationUpdatedFactSchema = defineFact({
  type: "account.project.registration.updated",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Union([KnownAccountProjectPayload, ForgottenAccountProjectPayload]),
})

const AccountProjectFactSchemas = [AccountProjectRegistrationUpdatedFactSchema] as const
const AccountProjectFactSchema = Schema.Union(AccountProjectFactSchemas)

export type AccountProjectFact = typeof AccountProjectFactSchema.Type

export function parseAccountProjectFact(value: unknown): AccountProjectFact {
  return Schema.decodeUnknownSync(AccountProjectFactSchema, { onExcessProperty: "error" })(value)
}
