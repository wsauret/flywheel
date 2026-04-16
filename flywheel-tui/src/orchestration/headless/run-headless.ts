import { HeadlessAdapter } from "./headless-adapter.js"
import { createSessionStore } from "../session-store.js"
import { buildQueueFromTemplate } from "../../workflows/queue/templates.js"
import { randomUUID } from "node:crypto"

export async function runHeadless(description: string): Promise<boolean> {
  const factories = { createAdapter: () => new HeadlessAdapter({ logLevel: "normal", timestamps: true }) }
  const sessionStore = createSessionStore(factories)
  const sessionId = randomUUID()
  const queue = buildQueueFromTemplate("work", description)

  const completed = await new Promise<boolean>((resolve) => {
    sessionStore.start({
      sessionId, queue, description,
      onRunnerDone: (_id, wfResult) => resolve(wfResult.completed),
      onRunnerError: () => resolve(false),
    })
  })

  await sessionStore.disposeAll()
  return completed
}
