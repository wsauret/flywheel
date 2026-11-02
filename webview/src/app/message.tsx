import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"

import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { attachmentKind } from "../../../src/protocol/client/attachments.js"
import { messageSenderLabel, PERSON_WORDS_LABEL } from "../../../src/protocol/client/message-sender.js"
import { undeliveredNotice, type LocalChatSubmission } from "../../../src/protocol/client/chat-submissions.js"
import type { HydratedOutputBlockBody } from "../../../src/protocol/transcript-protocol-types.js"
import { ImageViewer } from "./image-viewer.js"
import { RowTime } from "./row-time.js"
import { PersonText } from "./person-text.js"
import type { BlockDisclosure } from "./block-disclosure.js"

/** A message this client sent that the runtime has not shown back yet, drawn
 *  as the person's own message with its delivery state: queued, or not
 *  delivered with the way to take it back into the composer. */
export function LocalUserMessage(props: { readonly entry: LocalChatSubmission; readonly onEdit: () => void; readonly onImageLoad?: () => void; readonly sessionId: string; readonly disclosure: BlockDisclosure }) {
  const notice = () => undeliveredNotice(props.entry.delivery)
  const block = createMemo(() => ({
    kind: "userMessage" as const, id: `local:${props.entry.id}`, content: props.entry.input.invocation?.args ?? props.entry.input.text,
    timestamp: props.entry.timestamp, pending: notice() === undefined, injected: false,
  }))
  const body = createMemo(() => ({
    blockId: block().id,
    images: (props.entry.input.attachments ?? []).filter((attachment) => attachmentKind(attachment.mediaType, attachment.name ?? "") === "image"),
  }))
  return (
    <div class="timed-block">
    <RowTime timestamp={props.entry.timestamp} text={block().content} />
    <UserMessage block={block()} body={body()} onHydrate={() => {}} onImageLoad={props.onImageLoad} sessionId={props.sessionId} disclosure={props.disclosure}
      delivery={{ notice: notice(), onEdit: props.onEdit }} />
    </div>
  )
}

export function UserMessage(props: {
  block: Extract<FrontendOutputBlock, { kind: "userMessage" }>
  body?: HydratedOutputBlockBody | undefined
  onHydrate: (blockId: string) => void
  onImageLoad?: (() => void) | undefined
  sessionId: string
  disclosure: BlockDisclosure
  initialMessageLabel?: string | undefined
  /** Present for a local message: `notice` says that it is not delivered or not confirmed, and why. */
  delivery?: { readonly notice: string | undefined; readonly onEdit: () => void }
}) {
  const [viewing, setViewing] = createSignal<{ image: NonNullable<HydratedOutputBlockBody["images"]>[number]; label: string }>()
  const imageBodyId = createMemo(() => props.block.imageCount ? props.block.id : undefined)
  createEffect(on(
    imageBodyId,
    (id) => { if (id !== undefined && props.body === undefined) props.onHydrate(id) },
  ))

  const initialOpen = () => props.disclosure.state(props.sessionId, `initial:${props.block.id}`)().open
  return (
    <div class="message">
      <Show when={props.initialMessageLabel}>{label => <button class="initial-message-row" aria-expanded={initialOpen()}
        onClick={() => props.disclosure.setOpen(props.sessionId, `initial:${props.block.id}`, !initialOpen())}>
        <span class="chevron" aria-hidden="true">{initialOpen() ? "▾" : "▸"}</span>{label()}
      </button>}</Show>
      <Show when={props.initialMessageLabel === undefined || initialOpen()}>
      <div class="block user" classList={{ pending: props.block.pending, "from-session": props.block.from !== undefined }}>
        <Show when={props.block.from}>
          {(from) => <div class="user-sender">{messageSenderLabel(from())}</div>}
        </Show>
        <Show when={props.block.from === undefined} fallback={<div class="user-text">{props.block.content}</div>}>
          <PersonText content={props.block.content} sessionId={props.sessionId} blockId={props.block.id} disclosure={props.disclosure} />
        </Show>
        <Show when={props.block.from?.personWords}>
          {(words) => (
            <div class="user-person-words">
              <div class="user-sender">{PERSON_WORDS_LABEL}</div>
              <div class="user-text">{words()}</div>
            </div>
          )}
        </Show>
        <Show when={props.body?.images?.length}>
          <div class="user-images">
            <For each={props.body?.images}>
              {(image, index) => (
                <button class="image-preview" aria-label={`View Image #${index() + 1}`}
                  onClick={() => setViewing({ image, label: `Image #${index() + 1}` })}>
                <img
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt={`Image #${index() + 1}`}
                  loading="lazy"
                  decoding="async"
                  onLoad={() => props.onImageLoad?.()}
                />
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.delivery?.notice} fallback={<Show when={props.block.pending}><div class="user-delivery">Queued</div></Show>}>
          {(notice) => (
            <div class="user-delivery failed">
              <span class="user-delivery-cause">{notice()}</span>
              <button type="button" class="ghost-text user-delivery-edit" aria-label="Edit the message that was not delivered" onClick={() => props.delivery?.onEdit()}>Edit</button>
            </div>
          )}
        </Show>
      </div>
      </Show>
      <Show when={viewing()} keyed>{(selection) => <ImageViewer image={selection.image} label={selection.label} onClose={() => setViewing(undefined)} />}</Show>
    </div>
  )
}
