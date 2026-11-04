/** @jsxImportSource @opentui/solid */
import type { SideQuestionModel } from "./model.js"
import { Show } from "solid-js"
import { Button } from "../../components/button.js"
import { ComposerBody } from "../../components/composer-frame.js"
import { ModalFrame, MODAL_FRAME_HORIZONTAL_INSET } from "../../components/modal-frame.js"
import { useModalDimensions } from "../../hooks/use-modal-dimensions.js"
import { useTheme } from "../../context/theme.js"
import { MarkdownBody } from "../../output-blocks/markdown/markdown-body.js"
import { SIDE_QUESTION_COMMAND_NAME } from "../../../protocol/modules/side-question.js"

/** A bounded answer viewport leaves the follow-up composer and actions visible. */
export function SideQuestionModal(props: { model: SideQuestionModel }) {
  const { theme } = useTheme()
  const { modalWidth, termHeight } = useModalDimensions(88)
  const compact = () => modalWidth() < 60 || termHeight() < 28
  const row = () => props.model.selected()
  const state = () => props.model.request()?.state ?? "done"
  const index = () => props.model.rows().findIndex((item) => item.id === row()?.id)
  const disabled = () => !!props.model.pending()
  const canAsk = () => !disabled() && props.model.view()?.current?.state !== "running" && props.model.draft().trim().length > 0 && props.model.draft().trim().length <= props.model.questionLimit
  return <ModalFrame title={SIDE_QUESTION_COMMAND_NAME} width={modalWidth()} height={Math.max(1, termHeight() - 2)} onClose={props.model.close} gap={compact() ? 0 : 1}>
    <text flexShrink={0} fg={theme.textMuted}>Temporary · no tools</text>
    <box flexDirection="row" flexShrink={0} gap={1} flexWrap="wrap">
      <Button label="Previous" focused={props.model.focus() === 1} disabled={index() <= 0} onPress={() => props.model.browse(-1)} />
      <text fg={theme.textMuted}>{props.model.rows().length ? `${index() + 1} of ${props.model.rows().length}` : "No side history"}</text>
      <Button label="Next" focused={props.model.focus() === 2} disabled={index() >= props.model.rows().length - 1} onPress={() => props.model.browse(1)} />
    </box>
    <scrollbox ref={props.model.scroll.attach} minHeight={1} flexGrow={1} flexShrink={1} scrollY scrollX={false}>
      <box flexDirection="column" gap={compact() ? 0 : 1}>
        <Show when={row()} fallback={<text fg={theme.textMuted}>Ask a side question. The main chat continues.</text>}>{(selected) => <>
          <text fg={theme.primary}>{selected().question}</text>
          <Show when={selected().answer} fallback={<text fg={theme.textMuted}>{state() === "running" ? "Waiting for an answer..." : "No answer."}</text>}>
            <MarkdownBody cache={state() !== "running"}>{selected().answer}</MarkdownBody>
          </Show>
        </>}</Show>
      </box>
    </scrollbox>
    <Show when={props.model.error()}>{(error) => <text flexShrink={0} fg={theme.error}>{error()}</text>}</Show>
    <Show when={props.model.running()}><text flexShrink={0} fg={theme.textMuted}>Answering...</text></Show>
    <Show when={state() === "stopped"}><text flexShrink={0} fg={theme.warning}>Stopped</text></Show>
    <Show when={state() === "error"}><text flexShrink={0} fg={theme.error}>{props.model.request()?.error ?? "The side question failed."}</text></Show>
    <text flexShrink={0} fg={theme.textMuted}>{props.model.pending() ?? (compact() ? "Enter sends · Tab actions · Esc" : "Enter sends · Shift+Enter adds a line · Tab selects actions · Esc closes")}</text>
    <box flexShrink={0}>
      <ComposerBody theme={theme} width={modalWidth() - MODAL_FRAME_HORIZONTAL_INSET} lines={3} text={props.model.draft()} placeholder="Ask a question or follow up" attach={props.model.attach} onSubmit={() => { if (canAsk()) void props.model.ask() }} />
    </box>
    <Show when={props.model.draft().trim().length > props.model.questionLimit}><text flexShrink={0} fg={theme.error}>{`Use at most ${props.model.questionLimit} characters.`}</text></Show>
    <box flexDirection="row" flexShrink={0} gap={compact() ? 0 : 1} flexWrap="wrap">
      <Button label="Ask" disabled={!canAsk()} onPress={() => { void props.model.ask() }} />
      <Button label="Copy" focused={props.model.focus() === 3} disabled={!row()?.answer} onPress={() => { void props.model.copy() }} />
      <Button label="Clear" focused={props.model.focus() === 4} disabled={disabled() || !props.model.rows().length} onPress={() => { void props.model.clear() }} />
      <Button label="Stop" focused={props.model.focus() === 5} disabled={disabled() || !props.model.running()} onPress={() => { void props.model.stop() }} />
      <Button label="Keep as fork" focused={props.model.focus() === 6} disabled={disabled() || !props.model.retained()} onPress={() => { void props.model.keep() }} />
      <Button label="Close" focused={props.model.focus() === 7} onPress={props.model.close} />
    </box>
  </ModalFrame>
}
