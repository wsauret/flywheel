import type { RuntimeConnection } from "../../src/protocol/client/connection.js"
import type { FrontendActivity } from "../../src/protocol/app-service-types.js"
import { blockIdentity, type IdentifiedBlock } from "../../src/protocol/block-identity.js"

export type LiveTransportBlock = IdentifiedBlock & {
  readonly content?: unknown
  readonly message?: unknown
  readonly level?: unknown
}

export type LiveTransportVerdict =
  | { readonly kind: "pending"; readonly reason: string }
  | { readonly kind: "passed"; readonly terminal: "assistant_text" | "system_error" }
  | { readonly kind: "failed"; readonly reason: string }

export function observeLiveBlocks<T extends LiveTransportBlock>(
  seen: Map<string, T>,
  blocks: readonly T[],
): void {
  for (const block of blocks) seen.set(blockIdentity(block), block)
}

export function liveTransportVerdict(
  blocks: readonly LiveTransportBlock[],
  activity: FrontendActivity | undefined,
  connection: RuntimeConnection["state"],
): LiveTransportVerdict {
  if (connection === "closed") return { kind: "failed", reason: "runtime connection closed" }
  const terminal = blocks.find((block) =>
    (block.kind === "text" && typeof block.content === "string" && block.content.trim().length > 0) ||
    (block.kind === "system" && block.level === "error"),
  )
  if (!terminal) return { kind: "pending", reason: "no terminal transcript outcome" }
  if (activity !== "idle" && activity !== "absent") {
    return { kind: "pending", reason: `session activity is ${activity ?? "unknown"}` }
  }
  if (connection !== "connected") return { kind: "pending", reason: `runtime connection is ${connection}` }
  return {
    kind: "passed",
    terminal: terminal.kind === "system" ? "system_error" : "assistant_text",
  }
}
