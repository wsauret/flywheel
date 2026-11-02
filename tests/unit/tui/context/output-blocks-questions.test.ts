import { describe, it, expect } from "bun:test";
import { safeParse } from "../../../helpers/schema-assertions.js";
import { AnyBlockSchema } from "../../../../src/infra/output-blocks";
import type { QuestionBlock } from "../../../../src/infra/output-blocks";
import { adaptQuestionHistoryRows } from "../../../../src/tui/output-blocks/question-history-format.js";

/**
 * Output Blocks rendering logic tests — QuestionBlockSchema validation,
 * compact Q&A header/row derivation, and unanswered-question auto-scroll
 * predicate.
 */

// ── QuestionBlockSchema validation ──

describe("QuestionBlockSchema", () => {
  it("validates multi-question block with multiSelect and per-question header chips", () => {
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool_q2",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          choices: [
            { kind: "option", choiceId: "choice-1", label: "React", recommended: true },
            { kind: "option", choiceId: "choice-2", label: "Vue" },
            { kind: "freeform", label: "Other" },
          ],
          multiSelect: false,
        },
        {
          question: "Select features",
          header: "Features",
          choices: [
            { kind: "option", choiceId: "choice-1", label: "Dark mode" },
            { kind: "option", choiceId: "choice-2", label: "Auto-save" },
            { kind: "freeform", label: "Other" },
          ],
          multiSelect: true,
        },
      ],
      answers: { "Which framework?": "React", "Select features": "Dark mode, Auto-save" },
      cancelled: false,
      timestamp: 2000,
    };
    const result = safeParse(AnyBlockSchema, block);
    expect(result.success).toBe(true);
  });

  it("rejects missing required questions field", () => {
    const result = safeParse(AnyBlockSchema, {
      kind: "question",
      toolUseId: "tool_q3",
      timestamp: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects question entry missing choices", () => {
    const result = safeParse(AnyBlockSchema, {
      kind: "question",
      toolUseId: "tool_q4",
      questions: [{ question: "Pick one", multiSelect: false }],
      timestamp: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required toolUseId field", () => {
    const result = safeParse(AnyBlockSchema, {
      kind: "question",
      questions: [{ question: "Pick one", choices: [{ kind: "option", label: "A" }], multiSelect: false }],
      timestamp: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty choices array", () => {
    const result = safeParse(AnyBlockSchema, {
      kind: "question",
      toolUseId: "tool_q5",
      questions: [{ question: "Pick one", choices: [], multiSelect: false }],
      timestamp: 1000,
    });
    expect(result.success).toBe(true);
  });
});

// ── Compact Q&A rendering ──

describe("compact Q&A history rendering", () => {
  function entry(question: string, optionLabels: string[], header?: string): QuestionBlock["questions"][number] {
    return {
      question,
      ...(header !== undefined ? { header } : {}),
      choices: [
        ...optionLabels.map((label, index) => ({ kind: "option" as const, choiceId: `choice-${index + 1}`, label })),
        { kind: "freeform" as const, label: "Other" },
      ],
      multiSelect: false,
    }
  }

  it("adapts multi-question history into one railed row per question", () => {
    const firstQuestion = "the editor frame has a 3-row minimum body, plus top and bottom border rows. Should Flywheel match that height exactly?"
    const secondQuestion = "OpenTUI does not expose an exact per-edge border width, where only the top edge thickens to width 2 on hover/resize. How should we handle that?"
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool_mq",
      questions: [
        entry(firstQuestion, ["Match reference", "Use current"], "Height"),
        entry(secondQuestion, ["Skip thickening", "Approximate"], "Border"),
      ],
      answers: {
        [firstQuestion]: "Match reference",
        [secondQuestion]: "Skip thickening",
      },
      timestamp: 1000,
    }

    const rows = adaptQuestionHistoryRows(block)

    expect(rows).toHaveLength(2)
    expect(rows[0]?.name).toBe("ask_user")
    expect(rows[0]?.id).toBe("tool_mq#q0")
    expect(rows[0]?.presentation).toEqual({ name: "Height", detail: "Match reference" })
    expect(rows[1]?.id).toBe("tool_mq#q1")
    expect(rows[1]?.presentation).toEqual({ name: "Border", detail: "Skip thickening" })
    expect(rows[0]?.content).toBeUndefined()
  })

  it("renders a cancelled unanswered question as an error row", () => {
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool_err",
      questions: [entry("Continue?", ["Yes"], "Scope")],
      cancelled: true,
      timestamp: 1000,
    }

    const rows = adaptQuestionHistoryRows(block)

    expect(rows[0]?.status).toBe("error")
    expect(rows[0]?.status === "error" && rows[0].errorMessage).toBe("Cancelled")
    expect(rows[0]?.presentation).toEqual({ name: "Scope", detail: "" })
  })

  it("marks an unanswered question in a resolved block without alarm color", () => {
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool_gap",
      questions: [entry("Continue?", ["Yes"], "Scope")],
      timestamp: 1000,
    }

    const rows = adaptQuestionHistoryRows(block)

    expect(rows[0]?.status).toBe("completed")
    expect(rows[0]?.presentation).toEqual({ name: "Scope", detail: "(unanswered)" })
  })

  it("marks a question a skip left in an answered block as cancelled", () => {
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool_skip",
      questions: [
        entry("First?", ["Yes"], "One"),
        entry("Second?", ["Yes"], "Two"),
      ],
      answers: { "First?": "Yes" },
      timestamp: 1000,
    }

    const rows = adaptQuestionHistoryRows(block)

    expect(rows[0]?.presentation).toEqual({ name: "One", detail: "Yes" })
    expect(rows[1]?.status === "error" && rows[1].errorMessage).toBe("Cancelled")
  })

  it("keeps answered rows completed while unanswered rows error in a cancelled block", () => {
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool_partial",
      questions: [
        entry("First?", ["Yes"], "One"),
        entry("Second?", ["Yes"], "Two"),
      ],
      answers: { "First?": "Yes" },
      cancelled: true,
      timestamp: 1000,
    }

    const rows = adaptQuestionHistoryRows(block)

    expect(rows[0]?.status).toBe("completed")
    expect(rows[0]?.presentation).toEqual({ name: "One", detail: "Yes" })
    expect(rows[1]?.status).toBe("error")
    expect(rows[1]?.status === "error" && rows[1].errorMessage).toBe("Cancelled")
  })

  it("falls back to the question text when a question has no header", () => {
    const question = "Which store should hold the cache?"
    const block: QuestionBlock = {
      kind: "question",
      toolUseId: "tool_nohdr",
      questions: [entry(question, ["SQLite"])],
      answers: { [question]: "SQLite" },
      timestamp: 1000,
    }

    const rows = adaptQuestionHistoryRows(block)

    expect(rows[0]?.presentation).toEqual({ name: question, detail: "SQLite" })
  })
})
