import type { AntigravityEngineHost } from "../../../../infra/antigravity-engine.js"
import { readAppVersion } from "../../../../infra/app-version.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { osAccount } from "../../../../infra/os-account.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import { RouteUnavailableError } from "../../../agent-runtime/llm/errors.js"
import { EngineUnavailableError, launchEngine, type EngineLaunchOptions, type EngineProcess } from "./engine-process.js"
import { createEngineRegistry, type EngineRegistry } from "./engine-registry.js"
import { loginGateAddress, loginGateHook } from "./login-gate.js"
import type { ToolListener } from "../tools/mcp-server.js"
import { openStepGate, type StepGate } from "./step-gate.js"

/** What every engine of this process shares, whichever login it runs on: this OS account, this platform, and this
 *  process's environment for the allowlist. Throws when the account database names no account for this process. */
export function antigravityEngineHost(): AntigravityEngineHost {
  return { account: osAccount(), platform: process.platform, hostEnvironment: process.env }
}

/** The engines of this process and what they share: the registry of engine processes, the one tool listener, and
 *  the step gate of each login that an engine runs on or launches on. */
export interface EngineRuntime {
  readonly registry: EngineRegistry<EngineProcess>
  /** The step gate of the login directory `loginDir`. An engine launches on a login only after the login's gate
   *  opened, and the gate stays open until the last engine of the login ended, so every live engine that the registry
   *  returns has one. */
  gate(loginDir: string): StepGate
  /** Closes every engine at once and waits until each exited and its login's gate closed, then closes the tool
   *  listener. */
  dispose(): Promise<void>
}

let current: EngineRuntime | undefined

/** The engine runtime of this process's module service, or none while no service of the module runs. */
export function currentEngineRuntime(): EngineRuntime | undefined {
  return current
}

/** The step gate of one login in this runtime: how many launches and live engines of the login use it, its opening
 *  while any does, and the close of its last opening, which a new opening waits for so two listeners never share the
 *  login's address. */
interface LoginGate {
  users: number
  opening: Promise<StepGate> | undefined
  gate: StepGate | undefined
  closed: Promise<void>
}

/**
 * Opens the engine runtime of the module's process service and makes it this process's current one, which clients,
 * `preferredAccount`, and logouts read. Opens nothing yet: the first launch opens the tool listener, which loads the
 * MCP SDK, and each login's step gate opens at its address (`loginGateAddress`) with the first launch on the login and
 * closes when the login's last launch failed or its last engine ended, so an idle runtime holds no login's address.
 * Each launch runs `launch` (`launchEngine`; tests give a fake) with `launcher`, Flywheel's own client identity, and
 * the tree's tools.
 */
export function openEngineRuntime(options: { readonly launcher: Pick<LauncherScope, "spawnOwned">; readonly launch?: (options: EngineLaunchOptions) => Promise<EngineProcess> }): EngineRuntime {
  const launch = options.launch ?? launchEngine
  let toolListener: Promise<ToolListener> | undefined
  const openToolListener = (): Promise<ToolListener> => {
    const opening = toolListener ?? import("../tools/mcp-server.js").then((server) => server.openToolListener())
    toolListener = opening
    // A listener that did not open is opened again by the next launch.
    opening.catch(() => { if (toolListener === opening) toolListener = undefined })
    return opening
  }
  const logins = new Map<string, LoginGate>()
  const acquireGate = async (loginDir: string): Promise<LoginGate> => {
    let login = logins.get(loginDir)
    if (login === undefined) {
      login = { users: 0, opening: undefined, gate: undefined, closed: Promise.resolve() }
      logins.set(loginDir, login)
    }
    const held = login
    held.users += 1
    held.opening ??= held.closed.then(() => openStepGate(loginGateAddress(loginDir)))
    try {
      held.gate = await held.opening
      return held
    } catch (error) {
      await releaseGate(loginDir, held)
      throw error
    }
  }
  const releaseGate = (loginDir: string, login: LoginGate): Promise<void> => {
    login.users -= 1
    if (login.users > 0) return login.closed
    const opening = login.opening
    login.opening = undefined
    login.gate = undefined
    if (opening !== undefined) login.closed = opening.then((gate) => gate.dispose(), () => {})
    const closed = login.closed
    void closed.then(() => { if (login.users === 0 && login.closed === closed && logins.get(loginDir) === login) logins.delete(loginDir) })
    return closed
  }
  const registry = createEngineRegistry<EngineProcess>(async (place) => {
    let host: AntigravityEngineHost
    try {
      host = antigravityEngineHost()
    } catch (error) {
      throw new EngineUnavailableError("launch-failed", `The Google Antigravity engine has no OS account to run on: ${errorMessage(error)}`)
    }
    const [listener, version] = await Promise.all([openToolListener(), readAppVersion()])
    const login = await acquireGate(place.loginDir)
    let engine: EngineProcess
    try {
      engine = await launch({
        loginDir: place.loginDir, launcher: options.launcher, host, gateHook: loginGateHook(place.loginDir), toolListener: listener,
        tools: place.tools, clientInfo: { name: "flywheel", version },
      })
    } catch (error) {
      await releaseGate(place.loginDir, login)
      throw error
    }
    // The engine's end includes the release of its login's gate, so a drain or a release that waits for the end also
    // waits until the login's address is free.
    const ended = engine.ended.then(async (end) => {
      await releaseGate(place.loginDir, login)
      return end
    })
    return { ...engine, get served() { return engine.served }, ended, close: async (reason) => { await engine.close(reason); return await ended } }
  })
  const runtime: EngineRuntime = {
    registry,
    gate(loginDir) {
      const gate = logins.get(loginDir)?.gate
      if (gate === undefined) throw new RouteUnavailableError(`The Google Antigravity step gate of ${loginDir} is not open.`)
      return gate
    },
    async dispose() {
      if (current === runtime) current = undefined
      await registry.drain()
      await toolListener?.then((listener) => listener.close(), () => {})
    },
  }
  current = runtime
  return runtime
}
