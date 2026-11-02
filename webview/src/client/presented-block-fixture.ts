import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { foldTranscript } from "../../../src/protocol/client/transcript-model.js"
import { presentWebTranscript, type PresentedWebBlock } from "./tool-runs.js"

/** The block as the web transcript admits it, as its own row or as a member
 *  of its tool group, for a fixture that renders one block alone. Throws
 *  when the transcript does not render the block on its own. */
export function presentedBlock(block: FrontendOutputBlock): PresentedWebBlock {
  const admitted = presentWebTranscript(foldTranscript([block], true)).rows
    .flatMap((row): readonly PresentedWebBlock[] => row.kind === "toolGroup" ? row.members : [row])
    .find(row => row === block)
  if (admitted === undefined) throw new Error(`The web transcript does not render a lone ${block.kind} block`)
  return admitted
}
