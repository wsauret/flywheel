import { embeddedEntrySpecifier, runsThroughBun } from "../../infra/platform/cli-subprocess.js"
import type { StartupDirectories } from "../../infra/platform/files/directory-authorities.js"
import { Log } from "../../infra/diagnostics/log.js"
import { lockCommandSupervisorEntry } from "../../infra/supervision/launch/command-supervisor-entry.js"
import { createLauncherScope, createProcessSupervisor, guardianCommand, type LauncherContext, type ProcessSupervisor } from "../../infra/process-supervisor.js"
import { startupTrace } from "../../infra/diagnostics/startup-trace.js"
import type { AttachedRuntimeClient } from "../../protocol/runtime/app-service-types.js"
import type { RuntimeIdentity as DisplayedRuntimeIdentity } from "../../protocol/client/runtime/runtime-identity.js"
import type { RemoteAttach } from "../../orchestration/module-contract/terminal-remote.js"
import type { TerminalAttach } from "../../tui/terminal-attach.js"
import type { AccountRuntimeAttach } from "./runtime-attach.js"
import type { RuntimeIdentity } from "./runtime-identity-record.js"

const log = Log.create({ service: "runtime-launch" })

export interface CliLauncher extends LauncherContext {
  dispose(): Promise<void>
}

export async function createCliLauncher(supervisor?: ProcessSupervisor): Promise<CliLauncher> {
  const owned = supervisor ?? createProcessSupervisor({ guardianCommand: guardianCommand() })
  const lock = supervisor === undefined ? await lockCommandSupervisorEntry() : undefined
  if (lock?.kind === "failed") log.warn("command supervisor entry was not locked; launches read the live module", { reason: lock.reason })
  const scope = createLauncherScope(owned)
  const launcher: CliLauncher = {
    scope,
    guardian: owned.guardian,
    startGuardian: () => owned.start(),
    async dispose() {
      const outcome = await scope.close()
      await owned.dispose()
      if (!outcome.settled) throw new Error(`process launcher did not settle: ${outcome.reason}`)
    },
  }
  return launcher
}

export interface RuntimeLaunchOptions extends StartupDirectories {
  readonly attach: AccountRuntimeAttach
}

export interface LaunchedRuntimeClient {
  readonly client: AttachedRuntimeClient
  /** Ends this process's use of the runtime: the attach starts no service
   *  from now on, and the client closes after its calls in flight finish. */
  readonly dispose: () => Promise<void>
}

export function runtimeWorkerUrl(): string {
  return runsThroughBun(process.execPath)
    ? new URL("../composition/worker-entry.ts", import.meta.url).href
    : embeddedEntrySpecifier(import.meta.dir, "worker-entry.js")
}

/** Connects the terminal to its selected project through the account service. */
export async function launchRuntimeClient(options: RuntimeLaunchOptions): Promise<LaunchedRuntimeClient> {
  startupTrace("socket runtime client start")
  log.info("socket runtime client start", { projectRoot: options.projectRoot })
  const { createSocketRuntimeClient } = await import("../../orchestration/app-service/account/connections/socket-runtime-client.js")
  const client = createSocketRuntimeClient({
    socketPath: options.attach.socketPath,
    // The terminal learns the identity from its startup attach and then
    // from each snapshot, so a reconnect's attach needs only to settle.
    ensureRuntime: (report) => options.attach.ensure(report).then(() => {}),
    connectionPreface: options.attach.connectionPreface,
  })
  startupTrace("socket runtime client created")
  return {
    client,
    dispose: () => {
      options.attach.close()
      return client.close()
    },
  }
}

/** The terminal's runtime client, however it reaches the runtime, with what
 *  the shell shows of that reach. */
export interface TerminalRuntime extends LaunchedRuntimeClient {
  readonly attach: TerminalAttach
  /** The project as the shell names it before the runtime's first snapshot. */
  readonly projectRoot: string
  /** The serving build the welcome card names before the catalog arrives. Never rejects. */
  readonly attachedIdentity: Promise<DisplayedRuntimeIdentity | undefined>
}

/** How the terminal reaches its project's runtime: the account service on
 *  this machine, or a remote machine through the relay (PI-REMOTE-016). */
export type TerminalLaunch =
  | { readonly kind: "local"; readonly attach: AccountRuntimeAttach; readonly attached: Promise<RuntimeIdentity | undefined> }
  | { readonly kind: "relay"; readonly remote: RemoteAttach }
