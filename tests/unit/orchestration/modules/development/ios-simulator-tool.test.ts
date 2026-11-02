import { describe, expect, test } from "bun:test"
import type { McpCallResult } from "../../../../../src/orchestration/agent-runtime/mcp-result.js"
import {
  createIosSimulatorTool,
  executeIosSimulator,
  type IosSimulatorRequest,
} from "../../../../../src/orchestration/modules/development/ios-simulator-tool.js"

interface ToolArguments {
  readonly [key: string]: unknown
}

function result(overrides: Partial<McpCallResult> = {}): McpCallResult {
  return { content: [{ type: "text", text: "ok" }], isError: false, ...overrides }
}

describe("ios simulator tool", () => {
  test("maps an allowlisted public action to its MCP name and forwards object arguments", async () => {
    const calls: Array<{ workflow: string; action: string; mcpName: string; arguments: ToolArguments; signal: AbortSignal | undefined }> = []
    const response = await executeIosSimulator({
      execute: async (request, signal) => {
        if (request.kind === "schema") return result()
        calls.push({ ...request, signal })
        return result()
      },
      platform: "darwin",
    }, {
      workflow: "ui-automation",
      action: "snapshot-ui",
      arguments: { simulatorId: "device-1" },
    }, new AbortController().signal)

    expect(response).toEqual({ content: [{ type: "text", text: "ok" }], outcome: "ok" })
    expect(calls[0]).toMatchObject({
      kind: "call",
      workflow: "ui-automation",
      action: "snapshot-ui",
      mcpName: "snapshot_ui",
      arguments: { simulatorId: "device-1" },
      signal: expect.any(AbortSignal),
    })
  })

  test("maps public actions to pinned MCP tools and refuses destructive commands", async () => {
    const mappings = new Map<string, string>()
    const deps = {
      execute: async (request: IosSimulatorRequest) => {
        if (request.kind === "schema") return result()
        mappings.set(`${request.workflow}/${request.action}`, request.mcpName)
        return result()
      },
      platform: "darwin" as const,
    }

    const destructive = await executeIosSimulator(deps, { workflow: "simulator", action: "clean" })
    for (const [workflow, action] of [
      ["simulator", "boot"],
      ["simulator", "list"],
      ["simulator", "open"],
      ["simulator", "screenshot"],
      ["simulator-management", "set-appearance"],
      ["simulator-management", "statusbar"],
      ["simulator-management", "toggle-connect-hardware-keyboard"],
      ["simulator-management", "toggle-software-keyboard"],
      ["ui-automation", "batch"],
      ["ui-automation", "button"],
      ["ui-automation", "drag"],
      ["ui-automation", "gesture"],
      ["ui-automation", "key-press"],
      ["ui-automation", "key-sequence"],
      ["ui-automation", "long-press"],
      ["ui-automation", "screenshot"],
      ["ui-automation", "snapshot-ui"],
      ["ui-automation", "swipe"],
      ["ui-automation", "tap"],
      ["ui-automation", "tap-point"],
      ["ui-automation", "touch"],
      ["ui-automation", "type-text"],
      ["ui-automation", "wait-for-ui"],
    ]) await executeIosSimulator(deps, { workflow, action, arguments: {} })

    expect(destructive).toMatchObject({ outcome: "error", content: expect.stringContaining("refuses") })
    expect(Object.fromEntries(mappings)).toEqual({
      "simulator/boot": "boot_sim",
      "simulator/list": "list_sims",
      "simulator/open": "open_sim",
      "simulator/screenshot": "screenshot",
      "simulator-management/set-appearance": "set_sim_appearance",
      "simulator-management/statusbar": "sim_statusbar",
      "simulator-management/toggle-connect-hardware-keyboard": "toggle_connect_hardware_keyboard",
      "simulator-management/toggle-software-keyboard": "toggle_software_keyboard",
      "ui-automation/batch": "batch",
      "ui-automation/button": "button",
      "ui-automation/drag": "drag",
      "ui-automation/gesture": "gesture",
      "ui-automation/key-press": "key_press",
      "ui-automation/key-sequence": "key_sequence",
      "ui-automation/long-press": "long_press",
      "ui-automation/screenshot": "screenshot",
      "ui-automation/snapshot-ui": "snapshot_ui",
      "ui-automation/swipe": "swipe",
      "ui-automation/tap": "tap",
      "ui-automation/tap-point": "flywheel_tap_point",
      "ui-automation/touch": "touch",
      "ui-automation/type-text": "type_text",
      "ui-automation/wait-for-ui": "wait_for_ui",
    })
  })

  test("advertises workflow-specific action enums and discovers backend contracts", async () => {
    const tool = createIosSimulatorTool({
      execute: async (request) => request.kind === "schema"
        ? result({ structuredContent: {
          workflow: request.workflow,
          actions: [{ action: "tap", mcpName: "tap", inputSchema: { required: ["simulatorId", "elementRef"] } }],
        } })
        : result(),
      platform: "darwin",
    })
    // Anthropic rejects a tool whose schema root is not one object. A bare
    // oneOf root here blocked every request in the project on 2026-09-21.
    expect(tool.inputSchema).toMatchObject({ type: "object", required: ["workflow", "action"] })
    expect(JSON.stringify(tool.inputSchema)).not.toContain("oneOf")
    expect(tool.inputSchema).toMatchObject({ properties: {
      workflow: { enum: ["simulator", "simulator-management", "ui-automation"] },
      action: { enum: expect.arrayContaining(["schema", "snapshot-ui", "tap-point"]) },
    } })
    expect(JSON.stringify(tool.inputSchema)).not.toContain("\"clean\"")

    const listSchema = await executeIosSimulator({
      execute: async () => result({ structuredContent: {
        workflow: "simulator",
        actions: [{ action: "list", mcpName: "list_sims", inputSchema: { type: "object" } }],
      } }),
      platform: "darwin",
    }, { workflow: "simulator", action: "schema" })
    const snapshotSchema = await executeIosSimulator({
      execute: async () => result({ structuredContent: {
        workflow: "ui-automation",
        actions: [
          { action: "snapshot-ui", mcpName: "snapshot_ui", inputSchema: { required: ["simulatorId"] } },
          { action: "tap", mcpName: "tap", inputSchema: { required: ["simulatorId", "elementRef"] } },
        ],
      } }),
      platform: "darwin",
    }, { workflow: "ui-automation", action: "schema" })

    expect(JSON.stringify(listSchema.content)).toContain("list_sims")
    expect(JSON.stringify(snapshotSchema.content)).toContain("snapshot_ui")
    expect(JSON.stringify(snapshotSchema.content)).toContain("elementRef")
  })

  test("preserves text, image, and structured MCP output", async () => {
    const response = await executeIosSimulator({
      execute: async () => result({
        content: [
          { type: "text", text: "captured" },
          { type: "image", data: "aGVsbG8=", mediaType: "image/png" },
        ],
        structuredContent: { screenHash: "abc" },
      }),
      platform: "darwin",
    }, { workflow: "ui-automation", action: "screenshot", arguments: {} })

    expect(response).toEqual({
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: "aGVsbG8=", mediaType: "image/png" },
        { type: "text", text: "Structured result:\n{\"screenHash\":\"abc\"}" },
      ],
      outcome: "ok",
    })
  })

  test("reports an owned launch failure without throwing", async () => {
    const response = await executeIosSimulator({
      execute: () => { throw new Error("guardian unavailable") },
      platform: "darwin",
    }, { workflow: "simulator", action: "list" })

    expect(response).toEqual({ content: "XcodeBuildMCP operation failed: guardian unavailable", outcome: "error" })
  })
})
