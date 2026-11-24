import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { questionRecordRows, type FrontendQuestionBlock } from "./question-answer.js"

const block = (answers: FrontendQuestionBlock["answers"], cancelled?: boolean): FrontendQuestionBlock => ({
  kind: "question",
  toolUseId: "tu1",
  timestamp: 0,
  questions: [
    { question: "Which approach?", header: "Approach", choices: [{ kind: "freeform", label: "Other" }], multiSelect: false },
    { question: "Keep the tests?", choices: [{ kind: "freeform", label: "Other" }], multiSelect: false },
  ],
  ...(answers === undefined ? {} : { answers }),
  ...(cancelled === undefined ? {} : { cancelled }),
})

describe("question record rows", () => {
  test("titles each row by its header, falling back to the question, with the answer as detail", () => {
    const rows = questionRecordRows(block({ "Which approach?": "Isolated /tmp directory", "Keep the tests?": "Yes" }))
    assert.deepEqual(rows.map((row) => [row.title, row.detail, row.status]), [
      ["Approach", "Isolated /tmp directory", "completed"],
      ["Keep the tests?", "Yes", "completed"],
    ])
  })

  test("marks an unanswered question in a cancelled block as an error row", () => {
    const rows = questionRecordRows(block(undefined, true))
    assert.deepEqual(rows.map((row) => [row.detail, row.status]), [["Cancelled", "error"], ["Cancelled", "error"]])
  })

  test("marks a question a skip left in an answered block as cancelled", () => {
    const rows = questionRecordRows(block({ "Which approach?": "A" }))
    assert.deepEqual(rows[1], { id: "tu1#q1", title: "Keep the tests?", detail: "Cancelled", status: "error" })
  })
})
