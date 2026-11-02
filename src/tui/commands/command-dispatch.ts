import type { Accessor } from "solid-js"
import { SLASH_COMMAND_PATTERN } from "../../infra/slash-command.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { OffCommandDescriptor } from "../../protocol/command-catalog-protocol-types.js"
import { offCommandRefusal } from "../../protocol/client/off-command.js"
import { routeSlashToken, UNKNOWN_COMMAND_NOTICE, type CommandCatalogReadiness } from "../../protocol/client/slash-route.js"
import { createAcceptanceReporter } from "../hooks/report-async.js"
import type { ShellServices } from "../hooks/shell-state.js"
import type { BuiltInCommandDefinition, CommandSpec } from "./command-types.js"

const SLASH_PATTERN = SLASH_COMMAND_PATTERN
const QUOTED_ARG = /^"([\s\S]*)"$/

export interface CommandDispatchDeps<Context = unknown> {
  definitions: Accessor<readonly BuiltInCommandDefinition<Context>[]>
  context: Context
  showToast: ShellServices["showToast"]
  /** Commands that only a turned-off module provides. Typed exactly, one
   *  answers the shared refusal that names the module, never "Unknown command". */
  offCommands: Accessor<readonly OffCommandDescriptor[]>
  /** Whether the runtime's catalog has arrived: a token no command owns
   *  before then waits for it (`routeSlashToken`). */
  catalog: CommandCatalogReadiness
  /** Called with the resolved token after a command path consumed the input;
   *  feeds the account-global usage ranking. */
  recordUsage?: (token: string) => void
}

export interface CommandDispatch {
  /** Built-in ids and aliases, for slash completion. */
  completableNames(): string[]
  /** Every completable token plus the tokens of commands a turned-off module
   *  provides, which completion never offers but Enter still answers. */
  dispatchableNames(): string[]
  /** Parses and routes "/token arg" text, and resolves once the command
   *  settles. It resolves true only when a command accepted the input. Every
   *  other answer, an unknown token included, has already told the person
   *  why, so the caller only hands the input back. */
  dispatch(text: string): Promise<boolean>
}

/** Records accepted command use. A record still crossing when the terminal
 *  exits, such as the exit command's own, finishes before the runtime client
 *  closes, because that close lets every call in flight finish. A record the
 *  transport loses is not worth a word to the person. */
export function createCommandUsageRecorder(appService: Pick<RuntimeClient, "dispatch">): (token: string) => void {
  return (token) => {
    void appService.dispatch({ type: "command_usage.record", name: token }).catch(() => {})
  }
}

/** Routes slash input to the built-in command that owns its token. */
export function createCommandDispatch<Context>(deps: CommandDispatchDeps<Context>): CommandDispatch {
  const settle = createAcceptanceReporter(deps.showToast)
  const definitions = () => deps.definitions()
  const specByToken = (): ReadonlyMap<string, CommandSpec> => {
    const specs = new Map<string, CommandSpec>()
    for (const { spec } of definitions()) {
      specs.set(spec.id, spec)
      for (const alias of spec.aliases ?? []) specs.set(alias, spec)
    }
    return specs
  }

  function completableNames(): string[] {
    return definitions().flatMap(({ spec }) => [spec.id, ...(spec.aliases ?? [])])
  }

  function dispatchableNames(): string[] {
    return [...completableNames(), ...deps.offCommands().flatMap((command) => [command.id, ...command.aliases])]
  }

  async function dispatch(text: string): Promise<boolean> {
    const m = text.match(SLASH_PATTERN)
    // SAFETY: group 1 is a required (non-optional) capture in SLASH_PATTERN, so it is present on any match.
    const token = m ? m[1]!.toLowerCase() : undefined
    if (token === undefined) {
      deps.showToast({ message: UNKNOWN_COMMAND_NOTICE, variant: "warning" })
      return false
    }
    const arg = m?.[2]?.replace(QUOTED_ARG, "$1")
    const routing = routeSlashToken(deps.catalog, () => routeToken(token, arg) ?? undefined)
    const settled = routing.kind === "waiting" ? await routing.settled : routing
    if (settled.kind === "routed") return await settled.route
    const refusal = settled.kind === "loading" ? settled.notice : offCommandRefusal(deps.offCommands(), token) ?? UNKNOWN_COMMAND_NOTICE
    deps.showToast({ message: refusal, variant: "warning" })
    return false
  }

  /** Null when no command owns the token. */
  function routeToken(token: string, arg: string | undefined): Promise<boolean> | null {
    const spec = specByToken().get(token)
    const definition = spec && definitions().find((candidate) => candidate.spec.id === spec.id)
    if (!definition) return null
    deps.recordUsage?.(token)
    return settle(async () => await definition.execute(deps.context, arg))
  }

  return { completableNames, dispatchableNames, dispatch }
}
