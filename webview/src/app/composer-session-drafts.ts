import { createEffect, createMemo, on, untrack } from "solid-js"
import type { ProtocolChatInputObject } from "../../../src/protocol/app-service-types.js"
import { createComposerDrafts } from "../client/composer-drafts.js"
import type { SessionMemory } from "../client/session-residents.js"

/** Owns session-addressed composer transfers and waits for a child send's receipt
 * before returning only its remaining local draft. It never selects or focuses. */
export function createComposerSessionDrafts(options: {
  readonly sessionId: () => string | undefined
  readonly parentSessionId: () => string | undefined
  readonly created: () => boolean
  readonly finished: () => boolean
  readonly memory: (id: string) => SessionMemory | undefined
  readonly read: () => ProtocolChatInputObject
  readonly write: (input: ProtocolChatInputObject) => void
  /** Makes `text` the box's draft and leaves its files as they are. */
  readonly commit: (text: string) => void
  readonly send: (input: ProtocolChatInputObject) => Promise<boolean>
  readonly report: () => void
}) {
  const sessionId = createMemo(options.sessionId)
  let current = untrack(sessionId)
  let sending: { source: string | undefined; parent: string | undefined; finished: boolean } | undefined
  const drafts = createComposerDrafts(options.memory, current)
  const empty = { text: "", attachments: [] }
  function appendInput(id: string, input: ProtocolChatInputObject): void {
    if (id !== current) { drafts.append(id, { text: input.text, attachments: input.attachments ?? [] }); return }
    const active = options.read()
    options.write({ text: active.text ? `${active.text}\n\n${input.text}` : input.text, attachments: [...active.attachments ?? [], ...input.attachments ?? []] })
  }
  function transfer(source: string | undefined, parent: string | undefined): void {
    if (!source || !parent) return
    const input = options.read()
    const result = drafts.finish(source, parent, { text: input.text, attachments: input.attachments ?? [] })
    if (result.moved) { options.write(result.active); options.report() }
  }
  function finish(): void {
    if (!options.finished()) return
    if (sending && sending.source === current) { sending.finished = true; return }
    transfer(current, options.parentSessionId())
  }
  createEffect(on(sessionId, (next) => untrack(() => {
    if (next === current) return
    current = next
    const active = options.read()
    const kept = drafts.move(next, { text: active.text, attachments: active.attachments ?? [] }, options.created())
    options.write(kept ?? empty)
    finish()
  })))
  createEffect(on(options.finished, (finished) => { if (finished) untrack(finish) }))
  return {
    capture: drafts.capture,
    adopt: drafts.adopt,
    appendInput,
    /** Sends `shown`, the words the box shows, with the draft's files. An
     *  admitted send first commits `shown` as the draft, so a recalled
     *  message sends as the draft and its receipt settles against it. */
    submitChild(shown: string): void {
      if (sending || !shown.trim()) return
      options.commit(shown)
      const input = options.read()
      const receipt = { source: current, parent: options.parentSessionId(), finished: options.finished() }
      sending = receipt
      void options.send({ ...input, text: input.text.trim() }).then((accepted) => {
        if (!accepted) return
        const active = options.read()
        options.write(drafts.settle(receipt.source, input.text, { text: active.text, attachments: active.attachments ?? [] }))
      }).finally(() => {
        sending = undefined
        if (receipt.finished) transfer(receipt.source, receipt.parent)
        finish()
      })
    },
  }
}
