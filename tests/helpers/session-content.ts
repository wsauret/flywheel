import type { ReadSessionContentNode, SessionContentNode, StageSessionContentNodes } from "../../src/infra/session-content.js"

export function sessionContentFixture() {
  const nodes = new Map<string, SessionContentNode>()
  const stage: StageSessionContentNodes = async rows => {
    for (const row of rows) nodes.set(row.sha256, row.node)
  }
  const read: ReadSessionContentNode = async hash => nodes.get(hash) ?? null
  return { stage, read }
}
