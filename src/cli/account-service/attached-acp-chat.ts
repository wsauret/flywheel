import type { StartupDirectories } from "../../infra/directory-authorities.js"
import { errorMessage } from "../../infra/error-message.js"
import type { RuntimeStartupStatus } from "../../protocol/runtime/app-service-types.js"
import type { ChatSettlementOutcome } from "../../protocol/session/chat-settlement-protocol-types.js"
import { AuthProfileManager } from "../../orchestration/auth/auth-profile-manager.js"
import { acpFraming } from "../../orchestration/app-service/headless/acp-chat.js"
import { runHeadlessChatChannel, type ChatTransport } from "../../orchestration/app-service/headless/headless-chat-channel.js"
import { createAccountRuntimeAttach } from "./runtime-attach.js"
import { launchRuntimeClient } from "./runtime-launch.js"

const AUTH_PROFILE_ENV = "FLYWHEEL_AUTH_PROFILE"

interface AttachedAcpChatOptions extends Pick<ChatTransport, "input" | "write"> {
  readonly directories: StartupDirectories
  readonly allowPersistentProcesses: boolean
  /** The profile that `--auth-profile` names: an id or a unique display name. */
  readonly authProfile: string | undefined
  readonly progressWriter: (line: string) => void
}

/** Runs an attended ACP chat as an ordinary interactive client of the
 *  resident account service, as a terminal does (ARCH-RUNTIME-004). It starts
 *  the service when nothing serves, takes no claim of the project, and its
 *  sessions are the project's, so the chats of a terminal and of every other
 *  client share them. Its tools run in the project root. Startup reports go
 *  to `progressWriter`. A turn that is still running when this process ends
 *  keeps running in the service, as a turn does when a terminal closes.
 *  Returns 0 for a drained conversation, 1 for failure, and 2 for a
 *  conversation that needs more input. */
export async function runAttachedAcpChat(options: AttachedAcpChatOptions): Promise<number> {
  const { directories, progressWriter } = options
  // The profile the person asks for is the chat's own. A service that this
  // process starts serves every client of the account, so it does not
  // inherit the request as an account-wide profile lock.
  const selector = options.authProfile ?? (process.env[AUTH_PROFILE_ENV] || undefined)
  Reflect.deleteProperty(process.env, AUTH_PROFILE_ENV)
  const attach = createAccountRuntimeAttach({ ...directories, allowPersistentProcesses: options.allowPersistentProcesses })
  let shown: string | undefined
  const report = (status: RuntimeStartupStatus): void => {
    if (status.kind !== "phase" || status.label === shown) return
    shown = status.label
    progressWriter(`Flywheel: ${status.label}`)
  }
  let authProfile: string | undefined
  try {
    authProfile = selector === undefined ? undefined : new AuthProfileManager({ ...directories, env: { [AUTH_PROFILE_ENV]: selector } }).inspect().id
    await attach.ensure(report)
  } catch (error) {
    attach.close()
    progressWriter(`Headless chat failed: ${errorMessage(error)}`)
    return 1
  }
  const runtime = await launchRuntimeClient({ ...directories, attach })
  const framing = acpFraming(directories.projectRoot)
  let outcome: ChatSettlementOutcome = "failed"
  try {
    outcome = await runHeadlessChatChannel(runtime.client, {
      input: options.input, write: options.write, progressWriter, framing, ...(authProfile === undefined ? {} : { authProfile }),
    })
  } catch (error) {
    progressWriter(`Headless chat failed: ${errorMessage(error)}`)
  } finally {
    await runtime.dispose()
    framing.close()
  }
  return outcome === "complete" ? 0 : outcome === "failed" ? 1 : 2
}
