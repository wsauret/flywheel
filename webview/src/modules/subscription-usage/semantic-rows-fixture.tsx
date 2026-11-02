import { mountSemanticComponent, type SemanticPublication } from "../../app/semantic-rows-fixture.js"
import type { FakeConnectionScript } from "../../client/runtime-connection-fixture.js"
import { UsageSheet } from "./sheet.js"
import { StatsSheet } from "./stats-sheet.js"

/** Mounts usage surfaces through the client query boundary. */
export function mountSemanticRows(kind: "accounts" | "stats", initial: SemanticPublication, connection: FakeConnectionScript = {}) {
  return mountSemanticComponent(kind === "accounts" ? UsageSheet : StatsSheet, initial, connection)
}
