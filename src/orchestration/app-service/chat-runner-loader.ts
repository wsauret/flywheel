import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { ChatRunnerDeps } from "../chat/runner.js"
import type { ChatRunner } from "../chat/runner-types.js"

const log = Log.create({ service: "chat-runner-loader" })

export interface ChatRunnerLoader {
  createRunner(deps: ChatRunnerDeps): Promise<ChatRunner>
  /** Warms the chat module and the effective profile's owned preparation.
   *  Never rejects; a failed warmup is logged and retried by the first send. */
  warm(): Promise<void>
}

interface ChatRunnerLoaderDeps {
  readonly authAdmission: Pick<ChatRunnerDeps["authAdmission"], "admitDefaults">
  readonly createRunner?: (deps: ChatRunnerDeps) => Promise<ChatRunner>
}

let chatRunnerModule: Promise<typeof import("../chat/runner.js")> | null = null

export function createChatRunnerLoader(deps: ChatRunnerLoaderDeps): ChatRunnerLoader {
  return {
    async createRunner(runnerDeps) {
      const createRunner = deps.createRunner ?? (await loadChatRunnerModule()).createChatRunner
      return createRunner(runnerDeps)
    },
    async warm() {
      if (deps.createRunner) return
      try {
        const outcomes = await Promise.allSettled([loadChatRunnerModule(), deps.authAdmission.admitDefaults()])
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason
      } catch (err) {
        log.warn("chat runner warmup failed; the first send will retry", { error: errorMessage(err), errorDetail: errorDetail(err) })
      }
    },
  }
}

function loadChatRunnerModule(): Promise<typeof import("../chat/runner.js")> {
  chatRunnerModule ??= import("../chat/runner.js")
  return chatRunnerModule
}
