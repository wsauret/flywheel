import type { QuestionBlock } from "@infra/output-blocks"
import { questionRecordState } from "../../protocol/client/question-settlement.js"
import type { ToolRenderEntry } from "./tool-entry-helpers.js"

// Each resolved question becomes its own railed row under the "Ask User"
// heading, mirroring how explore/exec runs rail their children. The row's
// presentation.name is the question title (ToolRow colors it like a tool
// name), and the detail is the answer, so no arrow separator is needed.
export function adaptQuestionHistoryRows(block: QuestionBlock): ToolRenderEntry[] {
  return block.questions.map((question, index) => {
    const record = questionRecordState(block, question.question)
    const base = {
      kind: "tool" as const,
      // Synthetic identity: `#` never appears in provider tool-use ids, so
      // these ids cannot alias a real tool row's disclosure key. The rows are
      // never expandable, so the key is also never written.
      id: `${block.toolUseId}#q${index}`,
      name: "ask_user",
      presentation: {
        name: question.header ?? question.question,
        detail: record.kind === "answered" ? record.text : "",
      },
      timestamp: block.timestamp,
    }
    if (record.kind === "cancelled") return { ...base, status: "error" as const, errorMessage: "Cancelled" }
    if (record.kind === "pending") return { ...base, presentation: { ...base.presentation, detail: "(unanswered)" }, status: "completed" as const }
    return { ...base, status: "completed" as const }
  })
}


