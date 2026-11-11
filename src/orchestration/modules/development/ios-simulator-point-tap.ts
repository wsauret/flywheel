import { dirname, join } from "node:path"
import type { OwnedCommandRunner } from "../../../infra/owned-command.js"
import type { McpCallResult } from "../../agent-runtime/mcp-result.js"

const POINT_TAP_TIMEOUT_MS = 30_000
const POINT_TAP_OUTPUT_BYTES = 65_536
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

interface PointTapArguments {
  readonly [key: string]: unknown
}

export const IOS_SIMULATOR_POINT_TAP_TOOL = "flywheel_tap_point"

export const IOS_SIMULATOR_POINT_TAP_SCHEMA = {
  type: "object",
  properties: {
    simulatorId: { type: "string", description: "The booted Simulator UDID." },
    x: { type: "number", minimum: 0, maximum: 2_000, description: "Horizontal device point from a simulator screenshot." },
    y: { type: "number", minimum: 0, maximum: 3_000, description: "Vertical device point from a simulator screenshot." },
  },
  required: ["simulatorId", "x", "y"],
  additionalProperties: false,
} as const

export interface IosSimulatorPointTapInput {
  readonly runOwnedCommand: OwnedCommandRunner
  readonly cliPath: string
  readonly arguments: PointTapArguments
  readonly signal?: AbortSignal
}

/** Taps one device point through the AXe binary bundled by the pinned XcodeBuildMCP package. */
export async function executeIosSimulatorPointTap(input: IosSimulatorPointTapInput): Promise<McpCallResult> {
  const extra = Object.keys(input.arguments).find((key) => key !== "simulatorId" && key !== "x" && key !== "y")
  if (extra) throw new Error(`tap-point does not accept '${extra}'`)
  const { simulatorId, x, y } = input.arguments
  if (typeof simulatorId !== "string" || !UUID.test(simulatorId)) throw new Error("tap-point requires a valid simulatorId")
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 2_000) throw new Error("tap-point x must be between 0 and 2000")
  if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 3_000) throw new Error("tap-point y must be between 0 and 3000")

  const axe = join(dirname(dirname(input.cliPath)), "bundled", "axe")
  const result = await input.runOwnedCommand([
    axe,
    "tap",
    "-x",
    String(x),
    "-y",
    String(y),
    // The default style's simulator tap reports success but has no effect on Safari web content on iOS 27.2; a physical touch down and up reaches every target.
    "--tap-style",
    "physical",
    "--udid",
    simulatorId,
  ], {
    signal: input.signal,
    timeoutMs: POINT_TAP_TIMEOUT_MS,
    maxOutputBytes: POINT_TAP_OUTPUT_BYTES,
  })
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
  const failed = result.timedOut || result.exitCode !== 0 || result.stdoutTruncated === true || result.stderrTruncated === true
  return {
    content: [{ type: "text", text: text || (failed ? "AXe point tap failed without output" : `Tapped device point (${String(x)}, ${String(y)})`) }],
    isError: failed,
    structuredContent: { simulatorId, x, y, exitCode: result.exitCode, timedOut: result.timedOut },
  }
}
