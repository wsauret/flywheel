/** The executable's internal components select their role before application
 * modules load. Command builders and the entry share these exact markers. */
export const EXECUTABLE_ROLES = {
  guardian: "--internal-role=guardian",
  commandSupervisor: "--internal-role=command-supervisor",
  binaryInstall: "--internal-role=binary-install",
  projectExecutor: "--internal-role=project-executor",
  mutationGit: "--internal-role=mutation-git",
} as const

export type ExecutableRole = typeof EXECUTABLE_ROLES[keyof typeof EXECUTABLE_ROLES]

export function internalExecutableRole(argv: readonly string[]): ExecutableRole | undefined {
  // Bun inserts an absolute entry path, including its virtual entry in compiled
  // binaries. Only the first argument after that prefix can select a role.
  const at = /^[\\/]|^[A-Za-z]:[\\/]/.test(argv[1] ?? "") ? 2 : 1
  const candidate = argv[at]
  return Object.values(EXECUTABLE_ROLES).find((role) => role === candidate)
}
