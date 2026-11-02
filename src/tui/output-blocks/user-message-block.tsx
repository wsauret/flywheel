/** @jsxImportSource @opentui/solid */

import type { UserMessageBlock as UserMessageBlockType, UserMessageImage } from "@infra/output-blocks"
import { StyledText, bold as stBold, fg as stFg, type TextChunk } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { VerticalBarBorder } from "@tui/utils/border"
import { bindSelectableStyledTextContent, bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { ITALIC } from "@tui/utils/text-attributes"
import { useBodyToggle, useHeaderToggle, useUnifiedToggle } from "@tui/hooks/use-body-toggle.js"
import { createContext, createEffect, createMemo, createSignal, For, on, Show, useContext, type Accessor } from "solid-js"
import { useBlockDisclosure } from "../context/block-disclosure.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import { useRowWidth } from "@tui/context/row-width.js"
import { useTranscriptViewportHeight } from "@tui/context/transcript-viewport.js"
import { createMeasuredWidth } from "@tui/hooks/create-measured-width.js"
import { MarkdownBody } from "./markdown/markdown-body.js"
import { markdownTextChunk } from "./markdown/format-token.js"
import { AttachmentImage } from "@tui/components/attachment-image.js"
import { ImageClip } from "@tui/components/image-clip.js"
import { useAttachmentImages } from "@tui/context/attachment-images.js"
import { messageDisclosureEntry, messageSenderLabel, PERSON_WORDS_LABEL } from "../../protocol/client/message-sender.js"
import { ToolEntry } from "./tool-entry.js"

interface UserMessageBlockProps {
  block: UserMessageBlockType & { imageCount?: number }
  deliveryUnconfirmed?: boolean
  onHydrateBody?: (blockId: string) => void
}

function ImagePreview(props: { image: UserMessageImage; width: number; label: string }) {
  const viewportHeight = useTranscriptViewportHeight()
  const presentation = useAttachmentImages()
  const { theme } = useTheme()
  const click = useBodyToggle(() => presentation.open !== undefined, () => presentation.open?.(props.image, props.label))
  return <ImageClip selectable={false} border={false} flexDirection="column"
    {...click.handlers}>
    <AttachmentImage image={props.image} width={Math.min(60, props.width)}
      height={Math.min(10, Math.floor(viewportHeight() / 3))} />
    <Show when={presentation.open}><text selectable={false} fg={click.hovered() ? theme.primary : theme.textMuted}>View {props.label}</text></Show>
  </ImageClip>
}

function MessageImages(props: { images: readonly UserMessageImage[] | undefined }) {
  const row = useRowWidth()
  const measured = createMeasuredWidth(() => row.width() - 2)
  return <Show when={props.images?.length}>
    <box ref={measured.ref} width="100%" flexDirection="column">
      <For each={props.images}>{(image, index) => <ImagePreview image={image} width={measured.width()} label={`Image #${index() + 1}`} />}</For>
    </box>
  </Show>
}

/** A sent message's words exactly as they were sent, as every client shows
 *  them. A message is not Markdown: `17*23 or 19*21` keeps its asterisks. */
function SentText(props: { children: string; inlineSuffix?: readonly TextChunk[] }) {
  return <text ref={bindSelectableStyledTextContent(() => new StyledText([markdownTextChunk(props.children), ...(props.inlineSuffix ?? [])]))} />
}

function previewLine(content: string, maxLen = 80): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 3)}...` : trimmed
    }
  }
  return "(empty)"
}

const InitialMessageContext = createContext<{ readonly id: Accessor<string | undefined>; readonly label: (block: UserMessageBlockType) => string }>()
export const InitialMessageProvider = InitialMessageContext.Provider

/** The original initial message keeps its identity and ordinary transcript disclosure. */
export function UserMessageBlock(props: UserMessageBlockProps) {
  const initial = useContext(InitialMessageContext)
  const { theme } = useTheme()
  const disclosure = useBlockDisclosure()
  const [local, setLocal] = createSignal(false)
  const key = () => `userMessage:${props.block.id}#initial`
  const expanded = () => disclosure.disclosure(key()) ?? local()
  const toggle = useUnifiedToggle(() => true, () => {
    const next = !expanded()
    setLocal(next)
    disclosure.setDisclosure(key(), next)
  }, expanded)
  return <Show when={initial && initial.id() === props.block.id} fallback={<UserMessageContent {...props} />}>
    <box flexDirection="column" flexShrink={0} {...toggle.handlers}>
      <box height={1}>
        <text fg={toggle.hovered() ? theme.text : theme.textMuted} wrapMode="none" overflow="hidden">{`${expanded() ? "▾" : "▸"} ${initial?.label(props.block) ?? ""}`}</text>
      </box>
      <Show when={expanded()}><box ref={toggle.body} flexDirection="column" flexShrink={0}><UserMessageContent {...props} /></box></Show>
    </box>
  </Show>
}

function UserMessageContent(props: UserMessageBlockProps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const pending = () => props.block.pending === true
  const injected = () => props.block.injected === true
  const disclosure = useBlockDisclosure()
  const key = () => `${blockIdentity(props.block)}#injected`
  const expanded = () => disclosure.disclosure(key()) ?? true
  const toggle = () => disclosure.setDisclosure(key(), !expanded())
  createEffect(on(
    () => [props.block.id, props.block.imageCount ?? 0, props.block.images === undefined] as const,
    ([id, count, needsImages]) => {
      if (count > 0 && needsImages) {
        props.onHydrateBody?.(`userMessage:${id}`)
      }
    },
  ))
  const headerToggle = useHeaderToggle(() => true, toggle)
  // Whole-body collapse: clicking the expanded injected body folds it back to
  // the one-line header (selection-guarded, see useBodyToggle). Hovering the
  // body lights its left rail; the header chevron carries the collapsed
  // affordance (accent at rest, bold on hover).
  const bodyToggle = useBodyToggle(() => true, toggle)

  const injectedHeader = createMemo(() => {
    const chunks: TextChunk[] = [
      stFg(theme.textMuted)("↳"),
      stFg(theme.textMuted)(" "),
      stBold(stFg(headerToggle.hovered() ? theme.textBright : theme.textMuted)("System")),
      headerToggle.hovered()
        ? stBold(stFg(theme.primaryBright)(` ${expanded() ? "▾" : "▸"}`))
        : stFg(theme.primary)(` ${expanded() ? "▾" : "▸"}`),
    ]
    if (!expanded()) {
      chunks.push(stFg(theme.textMuted)(` ${previewLine(props.block.content)}`))
    }
    return new StyledText(chunks)
  })
  const queuedSuffix = createMemo(() => props.deliveryUnconfirmed
    ? [markdownTextChunk(" (not confirmed; press Up to edit)", theme.warning, ITALIC)]
    : pending() ? [markdownTextChunk(" (queued)", theme.textMuted, ITALIC)] : undefined)

  return (
    <Show when={props.block.from?.relation !== "parent" ? props.block.from : undefined} fallback={
      // A message owns its left bar and padding instead of the dot gutter of
      // BlockFrame, so it renders straight into the transcript column.
      <Show when={injected()} fallback={
        // The bar tells who wrote the words: the person's own messages use
        // the secondary color, and a message from another session uses its
        // own color, with its sender header in the same color.
        <box
          border={["left"]}
          borderColor={pending() ? theme.textMuted : props.block.from ? theme.sessionMessage : theme.secondary}
          customBorderChars={VerticalBarBorder}
        >
          <box
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.backgroundElement}
            flexShrink={0}
            flexDirection="column"
          >
            <Show when={props.block.from}>
              {(from) => <text selectable={false} fg={theme.sessionMessage}>{messageSenderLabel(from())}</text>}
            </Show>
            <SentText inlineSuffix={queuedSuffix()}>{props.block.content}</SentText>
            <MessageImages images={props.block.images} />
            <Show when={props.block.from?.personWords}>
              {(words) => (
                <box paddingTop={1} flexDirection="column">
                  <text selectable={false} fg={theme.textMuted}>{PERSON_WORDS_LABEL}</text>
                  <SentText>{words()}</SentText>
                </box>
              )}
            </Show>
          </box>
        </box>
      }>
        {/* Injected message; expanded by default */}
        <box flexDirection="column">
          <box
            selectable={false}
            {...headerToggle.handlers}
          >
            <text
              ref={bindStyledTextContent(injectedHeader)}
              overflow="hidden"
              wrapMode="none"
            />
          </box>
          <Show when={expanded()}>
            <box
              ref={bodyToggle.body}
              border={["left"]}
              borderColor={bodyToggle.hovered() ? theme.primary : theme.textMuted}
              customBorderChars={VerticalBarBorder}
              {...bodyToggle.handlers}
            >
              <box
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={theme.backgroundElement}
                flexShrink={0}
                flexDirection="column"
              >
                <MarkdownBody cache>{props.block.content}</MarkdownBody>
              </box>
            </box>
          </Show>
        </box>
      </Show>
    }>
      {(from) => <ToolEntry block={messageDisclosureEntry(props.block, from())} disclosureId={`userMessage:${props.block.id}`} onHydrateBody={props.onHydrateBody} />}
    </Show>
  )
}
