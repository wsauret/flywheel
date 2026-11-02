import { describe, expect, it } from "bun:test"
import { workflowCallLaunched, workflowCallSource, workflowContentFileName, workflowSource, workflowSourceLabel } from "../../../../src/infra/tools/workflow-call-source.js"

describe("the source of a recorded workflow call", () => {
  it("refuses a named source for a live call while retaining its recorded label and child binding", () => {
    const source = { kind: "registered", definition_id: "debug" }
    expect(workflowSource(source)).toBeUndefined()
    const recorded = workflowCallSource({ source })
    expect(recorded).toEqual({ kind: "registered", definitionId: "debug" })
    expect(workflowSourceLabel(recorded!)).toBe("Debug")
    expect(workflowCallLaunched({ source, description: "Fix it" }, { workflowDefinitionId: "debug", description: "Fix it" })).toBe(true)
  })
  it.each([false, true])("reads registered, path, and content sources (JSON string: %s), and the earlier top-level id", (encoded) => {
    const sources = [
      { input: { kind: "registered", definition_id: "debug" }, expected: { kind: "registered", definitionId: "debug" } },
      { input: { kind: "path", path: "scratch/workflows/a.workflow.yaml" }, expected: { kind: "path", path: "scratch/workflows/a.workflow.yaml" } },
      { input: { kind: "content", content: "id: survey-routes\n" }, expected: { kind: "content", content: "id: survey-routes\n" } },
    ] as const
    for (const { input, expected } of sources) {
      expect(workflowCallSource({ source: encoded ? JSON.stringify(input) : input })).toEqual(expected)
    }
    expect(workflowCallSource({ workflow_definition_id: "debug", description: "d" })).toEqual({ kind: "registered", definitionId: "debug" })
  })

  it("reads no source from a call that names none it can launch", () => {
    expect(workflowCallSource(undefined)).toBeUndefined()
    expect(workflowCallSource({ description: "d" })).toBeUndefined()
    expect(workflowCallSource({ source: { kind: "path" } })).toBeUndefined()
    expect(workflowCallSource({ source: { kind: "registered", path: "a.workflow.yaml" } })).toBeUndefined()
    expect(workflowCallSource({ source: { kind: "content", path: "a.workflow.yaml" } })).toBeUndefined()
    for (const source of ["{", "null", "[]", '{"kind":"path"}']) {
      expect(workflowCallSource({ source })).toBeUndefined()
    }
    expect(workflowCallSource({ source: "{", workflow_definition_id: "debug" })).toEqual({ kind: "registered", definitionId: "debug" })
  })

  it("labels a registered source by its id and a path source by its file name", () => {
    expect(workflowSourceLabel({ kind: "registered", definitionId: "spec-and-implement" })).toBe("Spec And Implement")
    expect(workflowSourceLabel({ kind: "path", path: "/s/scratch/workflows/survey-routes.workflow.yaml" })).toBe("Survey Routes")
    // A content source is labeled by the file that its launch saves, so its
    // card reads as the card of a path launch of that file.
    expect(workflowSourceLabel({ kind: "content", content: "id: survey-routes\nname: Survey routes\n" })).toBe("Survey Routes")
  })

  it("names the file of a content source by the workflow id, or workflow when the content names no slug id", () => {
    expect(workflowContentFileName("id: survey-routes\nname: Survey routes\n")).toBe("survey-routes.workflow.yaml")
    for (const content of ["id: Survey Routes\n", "id: ../escape\n", "id: a.b\n", "name: No id\n", "id: [unclosed\n", "- a list\n"]) {
      expect(workflowContentFileName(content)).toBe("workflow.workflow.yaml")
    }
  })

  it("pairs a call with the child it launched by its source and its request", () => {
    const child = { workflowDefinitionId: "debug", description: "Fix it" }

    expect(workflowCallLaunched({ workflow_definition_id: "debug", description: "Fix it" }, child)).toBe(true)
    expect(workflowCallLaunched({ source: { kind: "registered", definition_id: "debug" }, description: "Fix it" }, child)).toBe(true)
    expect(workflowCallLaunched({ source: { kind: "registered", definition_id: "qa" }, description: "Fix it" }, child)).toBe(false)
    expect(workflowCallLaunched({ source: '{"kind":"registered","definition_id":"qa"}', description: "Fix it" }, child)).toBe(false)
    // Only the launch read the id that a file declares, so a path call pairs by its request.
    expect(workflowCallLaunched({ source: { kind: "path", path: "a.workflow.yaml" }, description: "Fix it" }, child)).toBe(true)
    expect(workflowCallLaunched({ source: { kind: "path", path: "a.workflow.yaml" }, description: "Other" }, child)).toBe(false)
    // A content call launches the file that it saved, so it pairs as a path call does.
    expect(workflowCallLaunched({ source: { kind: "content", content: "id: a\n" }, description: "Fix it" }, child)).toBe(true)
  })
})
