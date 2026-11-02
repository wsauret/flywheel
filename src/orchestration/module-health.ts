import type { CommandHost } from "./app-service/command-host.js"

/** One section of the `/doctor` report: what a module checks about its own setup, such as an external program it
 *  runs or the library it reads. The kernel `/doctor` command runs the check of every enabled module in
 *  publication order. */
export interface ModuleHealthCheck {
  readonly title: string
  readonly check: (host: ModuleHealthHost) => Promise<ModuleHealthReport>
}

/** What a health check can read: the project's directories, the auth profile that new sessions use, and the
 *  process runner, which is absent in a composition that owns no launcher. */
type ModuleHealthHost = Pick<CommandHost, "directories" | "authDirectory" | "runOwnedCommand">

/** What one health check found: one line for each finding, and whether any of them needs the person to act. */
export interface ModuleHealthReport {
  readonly attention: boolean
  readonly lines: readonly string[]
}
