import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { simpleSettingRow } from "../../../src/tui/hooks/settings-modal-types.js"
import type { PersistedSettingDefinition } from "../../../src/orchestration/config/setting-definitions.js"

describe("settings definition propagation", () => {
  it("names a plain row and its feedback as its catalog row does", () => {
    const definition = {
      kind: "root-scalar",
      ownership: "generated-writer",
      id: "synthetic",
      path: ["synthetic"],
      applications: [{ mode: "live", path: [] }],
      protocolExposure: "ui-safe",
      schema: Schema.Boolean,
      reset: false,
      presentation: { kind: "simple-boolean", valueFormat: "yes-no" },
    } as const satisfies PersistedSettingDefinition
    let value: string | boolean = false
    const feedback: string[] = []

    const row = simpleSettingRow(definition, { id: "synthetic", label: "Synthetic setting", description: "Controls the synthetic behavior." }, {
      read: () => value,
      write: (_definition, next) => {
        value = next
        return { ok: true }
      },
      showFeedback: ({ message }) => { feedback.push(message) },
    })

    expect(row).toMatchObject({ kind: "cycle", id: "synthetic", label: "Synthetic setting", description: "Controls the synthetic behavior." })
    expect(row.kind === "cycle" && row.value()).toBe("NO")
    if (row.kind === "cycle") row.onActivate()
    expect(value).toBe(true)
    expect(feedback).toEqual(["Synthetic setting enabled"])
  })

  it("steps labeled enum values in both directions", () => {
    const definition = {
      kind: "nested-scalar",
      ownership: "generated-writer",
      id: "provider",
      path: ["web", "provider"],
      applications: [{ mode: "next-request", path: [] }],
      protocolExposure: "ui-safe",
      schema: Schema.Union([Schema.Literal("chatgpt"), Schema.Literal("exa")]),
      reset: "chatgpt",
      presentation: { kind: "simple-enum", values: ["chatgpt", "exa"], valueLabels: { chatgpt: "ChatGPT", exa: "Exa" }, valueFormat: "title-case" },
    } as const satisfies PersistedSettingDefinition
    let value: string | boolean = "chatgpt"
    const feedback: string[] = []
    const row = simpleSettingRow(definition, { id: "provider", label: "Web search provider", description: "The first provider." }, {
      read: () => value,
      write: (_definition, next) => {
        if (typeof next === "string") value = next
        return { ok: true }
      },
      showFeedback: ({ message }) => { feedback.push(message) },
    })
    if (row.kind !== "cycle") throw new Error("expected cycle row")

    expect(row.value()).toBe("ChatGPT")
    row.onStep?.(-1)
    expect(value).toBe("exa")
    expect(row.value()).toBe("Exa")
    expect(feedback).toEqual(["Web search provider set to Exa"])
  })
})
