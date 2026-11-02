import { Log } from "../../infra/log.js"
import type { RuntimeChatDefault } from "../../protocol/app-service-types.js"
import type { RuntimeGlobalDefaultRolesResult } from "../../protocol/model-assignment-protocol-types.js"
import { workspaceDomainCursor } from "../../protocol/runtime-ui-protocol-types.js"
import type { RuntimeConfigOwner } from "../config/runtime-config-owner.js"
import { createChatDefaultRefreshOwner, type ChatDefaultRefreshOwner } from "./model-assignment-admission.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"

const log = Log.create({ service: "chat-default-runtime" })

interface ChatDefaultRuntimeOptions {
  readonly initial: RuntimeChatDefault
  readonly resolve: () => Promise<RuntimeGlobalDefaultRolesResult>
  readonly bus: Pick<RuntimeUiBus, "publish">
  readonly runtimeConfig: Pick<RuntimeConfigOwner, "subscribe">
  readonly own: <T>(name: string, resource: T, dispose: (owned: T) => Promise<void> | void) => T
}

/** Owns deferred chat-default resolution and refresh triggers for one executor. */
export function createChatDefaultRuntime(options: ChatDefaultRuntimeOptions): ChatDefaultRefreshOwner {
  const owner = createChatDefaultRefreshOwner({
    initial: options.initial,
    resolve: options.resolve,
    publish: (chatDefault) => {
      options.bus.publish({ cursor: workspaceDomainCursor("chat_default"), payload: { kind: "chat_default.changed", chatDefault } })
    },
    onError: (error) => {
      log.warn("chat default refresh failed", { error: error instanceof Error ? error.message : String(error) })
    },
  })
  const refresh = (): void => { void owner.refresh() }
  options.own("chat-default-profiles-subscription", options.runtimeConfig.subscribe("profiles", refresh), (unsubscribe) => unsubscribe())
  return owner
}
