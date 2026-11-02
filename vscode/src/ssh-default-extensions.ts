export interface SshAutoInstallOfferContext {
  readonly isRemoteWindow: boolean
  readonly remoteSshInstalled: boolean
  readonly alreadyOffered: boolean
  readonly defaultExtensions: readonly string[]
  readonly extensionId: string
}

export interface UpdateSshDefaultExtensionsOptions {
  readonly enabled: boolean
  readonly remoteSshInstalled: boolean
  readonly defaultExtensions: readonly string[]
  readonly extensionId: string
  readonly write: (defaultExtensions: readonly string[]) => PromiseLike<void>
}

export type UpdateSshDefaultExtensionsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "remote_ssh_missing" }
  | { readonly ok: false; readonly reason: "write_failed"; readonly cause: unknown }

function hasExtension(defaultExtensions: readonly string[], extensionId: string): boolean {
  const normalizedId = extensionId.toLowerCase()
  return defaultExtensions.some((candidate) => candidate.toLowerCase() === normalizedId)
}

export function addDefaultExtension(defaultExtensions: readonly string[], extensionId: string): string[] {
  return hasExtension(defaultExtensions, extensionId) ? [...defaultExtensions] : [...defaultExtensions, extensionId]
}

export function removeDefaultExtension(defaultExtensions: readonly string[], extensionId: string): string[] {
  const normalizedId = extensionId.toLowerCase()
  return defaultExtensions.filter((candidate) => candidate.toLowerCase() !== normalizedId)
}

export function shouldOfferSshAutoInstall(context: SshAutoInstallOfferContext): boolean {
  return (
    !context.isRemoteWindow &&
    context.remoteSshInstalled &&
    !context.alreadyOffered &&
    !hasExtension(context.defaultExtensions, context.extensionId)
  )
}

/** Adds or removes Flywheel in `remote.SSH.defaultExtensions`. Without
 *  Remote - SSH, VS Code refuses to write the setting in either direction,
 *  and nothing reads it, so neither direction writes. */
export async function updateSshDefaultExtensions(
  options: UpdateSshDefaultExtensionsOptions,
): Promise<UpdateSshDefaultExtensionsResult> {
  if (!options.remoteSshInstalled) {
    return { ok: false, reason: "remote_ssh_missing" }
  }

  const next = options.enabled
    ? addDefaultExtension(options.defaultExtensions, options.extensionId)
    : removeDefaultExtension(options.defaultExtensions, options.extensionId)
  try {
    await options.write(next)
    return { ok: true }
  } catch (cause) {
    return { ok: false, reason: "write_failed", cause }
  }
}

export interface SshAutoInstallOfferSteps {
  /** Shows the offer and resolves with the person's answer, or undefined when they close it. */
  readonly ask: () => PromiseLike<"accept" | "decline" | undefined>
  /** Adds Flywheel to the setting and resolves false when that failed. */
  readonly enable: () => Promise<boolean>
  readonly recordOffered: () => PromiseLike<void>
  /** Says that automatic installation is on. Nothing waits for it to close. */
  readonly confirm: () => void
}

/** Asks once whether Flywheel installs itself on future SSH hosts. The answer
 *  is recorded as soon as the person gives it, because a confirmation can
 *  stay open for good and an unrecorded answer brings the offer back. An
 *  accepted offer whose write failed is not recorded, so it comes back. */
export async function runSshAutoInstallOffer(steps: SshAutoInstallOfferSteps): Promise<void> {
  const answer = await steps.ask()
  if (answer === "accept" && !await steps.enable()) return
  await steps.recordOffered()
  if (answer === "accept") steps.confirm()
}

/** Says in plain words why VS Code did not save the setting. VS Code's own
 *  error starts with an internal class name and can name a temporary file,
 *  which tell a person nothing they can act on. */
export function sshDefaultsWriteFailure(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  if (/not a registered configuration/i.test(detail)) return "VS Code saves this setting only while the Remote - SSH extension is installed."
  if (/EPERM|EACCES|EROFS|NoPermissions|permission denied/i.test(detail)) return "VS Code could not write your user settings file. Make sure the file is not locked or read-only, then try again."
  if (/correct errors/i.test(detail)) return "Your user settings file has errors. Correct them, then try again."
  if (/unsaved changes/i.test(detail)) return "Your user settings file has unsaved changes. Save it, then try again."
  return "VS Code could not save your user settings."
}
