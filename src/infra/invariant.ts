export type InvariantKind =
  | "missing-producer-event"
  | "orphan-event"
  | "duplicate-event"
  | "schema-mismatch"
  | "idempotency-violation"
  | "dispose-failure"

interface InvariantViolationInit {
  kind: InvariantKind
  eventType: string
  /** The stored version of the fact, when the violation is about one fact's body. */
  eventVersion?: number
  eventPosition: number
  aggregateId: string
  detail: string
}

export class InvariantViolation extends Error {
  readonly _tag = "InvariantViolation" as const
  readonly kind: InvariantKind
  readonly eventType: string
  readonly eventVersion: number | undefined
  readonly eventPosition: number
  readonly aggregateId: string
  readonly detail: string

  constructor(init: InvariantViolationInit, options?: { cause?: unknown }) {
    super(`${init.eventType}@${init.eventPosition}: ${init.detail}`, options)
    this.name = "InvariantViolation"
    this.kind = init.kind
    this.eventType = init.eventType
    this.eventVersion = init.eventVersion
    this.eventPosition = init.eventPosition
    this.aggregateId = init.aggregateId
    this.detail = init.detail
  }
}
