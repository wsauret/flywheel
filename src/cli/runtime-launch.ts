import { fileURLToPath } from "node:url"

import { embeddedEntrySpecifier, runsThroughBun } from "../infra/cli-subprocess.js"
import type { StartupDirectories } from "../infra/directory-authorities.js"
import { EXECUTABLE_ROLES } from "../infra/executable-roles.js"
import { Log } from "../infra/log.js"
import { lockCommandSupervisorEntry } from "../infra/command-supervisor-entry.js"
import { createLauncherScope, createProcessSupervisor, type LauncherContext, type ProcessSupervisor } from "../infra/process-supervisor.js"
import { startupTrace } from "../infra/startup-trace.js"
import type { AttachedRuntimeClient } from "../protocol/app-service-types.js"
import type { RuntimeIdentity as DisplayedRuntimeIdentity } from "../protocol/client/runtime-identity.js"
import type { RemoteAttach } from "../orchestration/terminal-remote.js"
import type { TerminalAttach } from "../tui/terminal-attach.js"
import type { AccountRuntimeAttach, RuntimeIdentity } from "./runtime-attach.js"

const log = Log.create({ service: "runtime-launch" })

/** A source run starts its guardian through the source entry, which holds
 *  the snapshot of a dev service that the guardian runs from (ARCH-DISTRIBUTION-030). */
export function guardianCommand(): readonly string[] {
  return runsThroughBun(process.execPath)
    ? [process.execPath, fileURLToPath(new URL("../../scripts/source-cli.ts", import.meta.url)), EXECUTABLE_ROLES.guardian]
    : [process.execPath, EXECUTABLE_ROLES.guardian]
}

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
    ? new URL("../orchestration/app-service/worker-entry.ts", import.meta.url).href
    : embeddedEntrySpecifier(import.meta.dir, "worker-entry.js")
}

/** Connects the terminal to its selected project through the account service. */
export async function launchRuntimeClient(options: RuntimeLaunchOptions): Promise<LaunchedRuntimeClient> {
  startupTrace("socket runtime client start")
  log.info("socket runtime client start", { projectRoot: options.projectRoot })
  const { createSocketRuntimeClient } = await import("../orchestration/app-service/socket-runtime-client.js")
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
