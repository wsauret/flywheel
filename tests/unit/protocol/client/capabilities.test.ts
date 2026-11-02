import { describe, expect, test } from "bun:test"

import { CAPABILITIES_DETAIL, everyProviderOff } from "../../../../src/protocol/client/capabilities.js"
import type { ModuleProtocolRow } from "../../../../src/protocol/module-protocol-types.js"

const provider = { control: "binary", group: "Model providers", label: "OpenAI API Key", description: "OpenAI" } as const
const tool = { control: "binary", group: "Tools", label: "Bash", description: "Bash" } as const
const row = (id: ModuleProtocolRow["id"], effective: boolean, setting: ModuleProtocolRow["setting"]): ModuleProtocolRow =>
  ({ id, installed: true, effective, dependencies: [], setting })

describe("the capability reading", () => {
  test("knows when the selection leaves no model provider on", () => {
    expect(everyProviderOff({ modules: [row("provider-openai-api", false, provider), row("bash", true, tool)] })).toBe(true)
    expect(everyProviderOff({ modules: [row("provider-openai-api", true, provider), row("bash", false, tool)] })).toBe(false)
  })
})

test("the Capabilities entry says that a change applies to every project, since the selection is account-wide", () => {
  expect(CAPABILITIES_DETAIL).toContain("every project")
  expect(CAPABILITIES_DETAIL).not.toContain("this project")
})
