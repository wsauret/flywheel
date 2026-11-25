/** The durable aggregate and content scope that owns recoverable work. */
export type DurableOwner =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "workflow"; readonly workflowId: string }

export function durableOwnerId(owner: DurableOwner): string {
  return owner.kind === "session" ? owner.sessionId : owner.workflowId
}

export function durableOwnerAggregate(owner: DurableOwner): string {
  return `${owner.kind}:${durableOwnerId(owner)}`
}
