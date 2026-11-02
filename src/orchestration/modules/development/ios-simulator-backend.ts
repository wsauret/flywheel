import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js"
import type { LauncherScope } from "../../../infra/process-supervisor.js"
import {
  BunStdioClientTransport,
  type BunStdioClientTransportOptions,
} from "../../agent-runtime/mcp-stdio-client-transport.js"
import { normalizeMcpCallResult, type McpCallResult } from "../../agent-runtime/mcp-result.js"

const STARTUP_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 120_000
const MAX_STARTUP_DIAGNOSTIC_CHARS = 16_384

interface Environment {
  readonly [key: string]: string
}

interface McpToolArguments {
  readonly [key: string]: unknown
}

export interface IosSimulatorBackend {
  readonly tools: ReadonlyMap<string, unknown>
  call(name: string, arguments_: McpToolArguments, signal?: AbortSignal): Promise<McpCallResult>
  close(): Promise<void>
  onClose(callback: () => void): void
}

export interface IosSimulatorBackendConnectionInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Environment
  readonly signal: AbortSignal
  readonly requiredTools: readonly string[]
  readonly spawnOwned: LauncherScope["spawnOwned"]
  readonly createTransport?: (options: BunStdioClientTransportOptions) => Transport
  readonly connectProtocol?: (transport: Transport, signal: AbortSignal) => Promise<IosSimulatorBackend>
}

/** Connects one owned XcodeBuildMCP process and preserves its bounded terminal startup diagnostic on failure. */
export async function connectOwnedIosSimulatorBackend(input: IosSimulatorBackendConnectionInput): Promise<IosSimulatorBackend> {
  let startupDiagnostic = ""
  const transportOptions: BunStdioClientTransportOptions = {
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: { ...input.env },
    signal: input.signal,
    spawnOwned: input.spawnOwned,
    onStderrRecord(record) {
      startupDiagnostic = `${startupDiagnostic}${startupDiagnostic ? "\n" : ""}${record}`.slice(-MAX_STARTUP_DIAGNOSTIC_CHARS)
    },
  }
  const transport = input.createTransport?.(transportOptions) ?? new BunStdioClientTransport(transportOptions)
  const client = new Client({ name: "flywheel-ios-simulator", version: "1" }, { capabilities: {} })
  try {
    if (input.connectProtocol) return await input.connectProtocol(transport, input.signal)
    await client.connect(transport, { signal: input.signal, timeout: STARTUP_TIMEOUT_MS })
    const listed = await client.listTools(undefined, { signal: input.signal, timeout: STARTUP_TIMEOUT_MS })
    let closeCallback = (): void => {}
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- boundary: MCP SDK exposes close as an assignable callback property.
    client.onclose = () => closeCallback()
    return {
      tools: new Map(listed.tools.map(({ name, inputSchema }) => [name, inputSchema])),
      async call(name, arguments_, signal) {
        const response = await client.request(
          { method: "tools/call", params: { name, arguments: arguments_ } },
          ResultSchema,
          { signal, timeout: CALL_TIMEOUT_MS },
        )
        return normalizeMcpCallResult(response)
      },
      close: () => client.close(),
      onClose(callback) { closeCallback = callback },
    }
  } catch (error) {
    await client.close().catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(startupDiagnostic
      ? `${message}\nXcodeBuildMCP startup diagnostic:\n${startupDiagnostic}`
      : message, { cause: error })
  }
}
