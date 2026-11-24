import type { MemoryWrittenFact } from "./memory-facts.js"

/** Actor of one memory write. The origin decides it, so the current writer and
 *  the version-1 upgrade derive it the same way. */
export function memoryWriteActor(origin: MemoryWrittenFact["payload"]["origin"]): MemoryWrittenFact["actor"] {
  return origin.kind === "user" ? "user" : "agent"
}

// One mutation of a bounded memory store. The runtime records it on behalf of
// whoever authored the write; the store file is the artifact, this is the
// audit trail. A writer always knows the identity of the append it prepares,
// so this constructor takes it directly and the payload's adopted-version-1
// identity case stays unreachable from any write path.
export function memoryWrittenFact(
  payload: Omit<MemoryWrittenFact["payload"], "identity"> & { readonly mutationId: string },
): MemoryWrittenFact {
  const { mutationId, ...rest } = payload
  return {
    type: "memory.written",
    version: 3,
    actor: memoryWriteActor(payload.origin),
    payload: { ...rest, identity: { kind: "recorded", mutationId } },
  } satisfies MemoryWrittenFact
}
