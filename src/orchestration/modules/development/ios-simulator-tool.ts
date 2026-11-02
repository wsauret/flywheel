import type { McpCallResult } from "../../agent-runtime/mcp-result.js"
import type { RuntimeTool, RuntimeToolInput, ToolResult } from "../../agent-runtime/tools/types.js"
import { IOS_SIMULATOR_POINT_TAP_TOOL } from "./ios-simulator-point-tap.js"

const INPUT_FIELDS = new Set(["action", "arguments", "snapshotToken", "workflow"])

export const IOS_SIMULATOR_ACTIONS = {
  simulator: {
    boot: "boot_sim",
    list: "list_sims",
    open: "open_sim",
    screenshot: "screenshot",
  },
  "simulator-management": {
    "set-appearance": "set_sim_appearance",
    statusbar: "sim_statusbar",
    "toggle-connect-hardware-keyboard": "toggle_connect_hardware_keyboard",
    "toggle-software-keyboard": "toggle_software_keyboard",
  },
  "ui-automation": {
    batch: "batch",
    button: "button",
    drag: "drag",
    gesture: "gesture",
    "key-press": "key_press",
    "key-sequence": "key_sequence",
    "long-press": "long_press",
    screenshot: "screenshot",
    "snapshot-ui": "snapshot_ui",
    swipe: "swipe",
    tap: "tap",
    "tap-point": IOS_SIMULATOR_POINT_TAP_TOOL,
    touch: "touch",
    "type-text": "type_text",
    "wait-for-ui": "wait_for_ui",
  },
} as const

export type SimulatorWorkflow = keyof typeof IOS_SIMULATOR_ACTIONS
export const REQUIRED_IOS_SIMULATOR_MCP_TOOLS = Object.freeze([
  ...new Set(Object.values(IOS_SIMULATOR_ACTIONS).flatMap((actions) => Object.values(actions))),
].filter((name) => name !== IOS_SIMULATOR_POINT_TAP_TOOL))

export interface IosSimulatorToolDeps {
  readonly execute: (request: IosSimulatorRequest, signal?: AbortSignal) => Promise<McpCallResult>
  readonly platform?: NodeJS.Platform
}

interface IosSimulatorArguments {
  readonly [key: string]: unknown
}

interface IosSimulatorSchemaRequest {
  readonly kind: "schema"
  readonly workflow: SimulatorWorkflow
  readonly action: "schema"
}

export interface IosSimulatorCallRequest {
  readonly kind: "call"
  readonly workflow: SimulatorWorkflow
  readonly action: string
  readonly mcpName: string
  readonly arguments: IosSimulatorArguments
  readonly snapshotToken?: string
}

export type IosSimulatorRequest = IosSimulatorSchemaRequest | IosSimulatorCallRequest

const WORKFLOWS = Object.keys(IOS_SIMULATOR_ACTIONS).filter(isWorkflow)
const ACTIONS = [...new Set(Object.values(IOS_SIMULATOR_ACTIONS).flatMap((actions) => Object.keys(actions)))]

function describeWorkflowActions(): string {
  return WORKFLOWS.map((workflow) => `${workflow}: ${Object.keys(IOS_SIMULATOR_ACTIONS[workflow]).join(", ")}`).join("; ")
}

// Providers reject a tool schema whose root is not one object, so the
// workflow-to-action pairing is one flat object here and parseRequest refuses
// an action that does not belong to the named workflow.
const INPUT_SCHEMA = {
  type: "object",
  properties: {
    workflow: { enum: WORKFLOWS, description: "The safe XcodeBuildMCP workflow." },
    action: {
      enum: ["schema", ...ACTIONS],
      description: `Use schema to discover backend-provided argument contracts, or select one allowlisted action of the named workflow. ${describeWorkflowActions()}.`,
    },
    arguments: {
      type: "object",
      description: "Backend arguments as one JSON object. Use this workflow's schema action to discover exact fields.",
      additionalProperties: true,
    },
    snapshotToken: {
      type: "string",
      description: "The opaque token returned by the latest snapshot-ui or wait-for-ui call. Required for actions that can consume element refs.",
    },
  },
  required: ["workflow", "action"],
  additionalProperties: false,
} as const

const DESCRIPTION = `Observe and pilot one iOS Simulator through the pinned XcodeBuildMCP backend. This tool permits simulator boot and display, semantic UI snapshots, screenshots, and UI interaction. It refuses build, clean, erase, uninstall, physical-device, and project-mutation commands.`

const GUIDELINES = [
  "Use each workflow's schema action before an unfamiliar call. It returns the pinned backend's exact argument contracts.",
  "Start with simulator list or boot, then use ui-automation snapshot-ui. Send its snapshotToken with an action that can consume an elementRef.",
  "After any UI action, discard the prior snapshotToken and capture a fresh semantic snapshot before another element-ref action.",
  "Use screenshots as visual evidence. Never click the Simulator through host-window coordinates and never fall back to desktop mouse automation.",
]

function isWorkflow(value: unknown): value is SimulatorWorkflow {
  return typeof value === "string" && Object.hasOwn(IOS_SIMULATOR_ACTIONS, value)
}

function parseRequest(input: RuntimeToolInput): IosSimulatorRequest | string {
  const extra = Object.keys(input).find((field) => !INPUT_FIELDS.has(field))
  if (extra) return `ios_simulator does not accept '${extra}'.`
  if (!isWorkflow(input.workflow)) return "ios_simulator requires workflow to be simulator, simulator-management, or ui-automation."
  const action = typeof input.action === "string" ? input.action : undefined
  if (action === "schema") {
    if (input.arguments !== undefined) return "ios_simulator schema does not accept arguments."
    if (input.snapshotToken !== undefined) return "ios_simulator schema does not accept a snapshotToken."
    return { kind: "schema", workflow: input.workflow, action }
  }
  const actions = new Map(Object.entries(IOS_SIMULATOR_ACTIONS[input.workflow]))
  const mcpName = action === undefined ? undefined : actions.get(action)
  if (!action || !mcpName) {
    return `ios_simulator refuses '${String(input.workflow)} ${String(input.action)}'; only non-destructive simulator observation, display, and UI automation actions are allowed.`
  }
  if (input.arguments !== undefined && !isRecord(input.arguments)) return "ios_simulator arguments must be a JSON object."
  if (input.snapshotToken !== undefined && typeof input.snapshotToken !== "string") return "ios_simulator snapshotToken must be a string."
  return {
    kind: "call",
    workflow: input.workflow,
    action,
    mcpName,
    arguments: input.arguments ?? {},
    ...(typeof input.snapshotToken === "string" ? { snapshotToken: input.snapshotToken } : {}),
  }
}

/** Executes one allowlisted operation through the development service's owned MCP process. */
export async function executeIosSimulator(deps: IosSimulatorToolDeps, input: RuntimeToolInput, signal?: AbortSignal): Promise<ToolResult> {
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { content: "iOS Simulator automation requires macOS with full Xcode and an installed iOS runtime.", outcome: "error" }
  }
  const request = parseRequest(input)
  if (typeof request === "string") return { content: request, outcome: "error" }

  try {
    const result = await deps.execute(request, signal)
    const structured = result.structuredContent === undefined
      ? []
      : [{ type: "text" as const, text: `Structured result:\n${JSON.stringify(result.structuredContent)}` }]
    return { content: [...result.content, ...structured], outcome: result.isError ? "error" : "ok" }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { content: `XcodeBuildMCP operation failed: ${message}`, outcome: "error" }
  }
}

/** Creates the development-only simulator tool. Construction performs no I/O; the backend starts on first execution. */
export function createIosSimulatorTool(deps: IosSimulatorToolDeps): RuntimeTool {
  return {
    name: "ios_simulator",
    action: "shell_exec",
    description: DESCRIPTION,
    promptSnippet: "Observe and pilot the iOS Simulator through semantic UI automation",
    promptGuidelines: GUIDELINES,
    inputSchema: INPUT_SCHEMA,
    validatesOwnInput: true,
    isConcurrencySafe: false,
    execute: (input, context) => executeIosSimulator(deps, input, context.signal),
  }
}

function isRecord(value: unknown): value is IosSimulatorArguments {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
