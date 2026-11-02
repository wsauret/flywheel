import { Show, type JSX } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { cardProfileName } from "../../../src/protocol/client/new-chat-card.js"

import { pageDomainReader } from "../client/module-domain-views.js"
import { formatRuntimeIdentity } from "../../../src/protocol/client/runtime-identity.js"
import { moduleRows } from "../../../src/protocol/modules.js"
import type { ModuleRow } from "../../../src/protocol/protocol-module.js"
import { useClient } from "./client-context.js"
import { Mark } from "./icons.js"
import "../styles/intro-card.css"

/** The blank transcript's card: what this session is set up with.
 *
 *  It answers the questions a person has before their first message, the way
 *  the terminal's intro card does and in the same words: which model will
 *  answer, which project and branch it is working in, and under which profile.
 *  Each fact that can change names the command that changes it, so the card
 *  teaches the command vocabulary the slash menu answers to. The rows every
 *  module contributes follow the kernel rows, from the same selectors the
 *  terminal card reads. */

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter((part) => part.length > 0).at(-1) ?? path
}

/** A "/command to change" affordance: the command is the link, the verb is a
 *  hint, exactly as the terminal card colours them. */
function CommandHint(props: { readonly command: string; readonly verb: string; readonly working?: boolean; readonly onClick: () => void }): JSX.Element {
  return (
    <span class="intro-hint">
      <button class="link" aria-busy={props.working || undefined} onClick={props.onClick}>{props.command}</button> {props.verb}
    </span>
  )
}

/** One module row in the card's grammar: a command action renders as the
 *  kernel's command rows do, a surface action as a hint that opens it, and
 *  anything else as a value with a muted hint. */
export function IntroModuleRow(props: { readonly row: ModuleRow; readonly onCommand: (id: string) => void; readonly working: (id: string) => boolean; readonly onSurface: (id: string) => void }): JSX.Element {
  const action = () => props.row.action
  return (
    <>
      <dt>{props.row.label}</dt>
      <dd>
        <span classList={{ "tone-warn": props.row.tone === "warning" }}>{props.row.value}</span>
        <Show when={action()} fallback={<Show when={props.row.hint}>{(hint) => <span class="intro-hint">{hint()}</span>}</Show>}>
          {(current) => current().kind === "command"
            ? <CommandHint command={`/${current().id}`} verb={props.row.hint ?? ""} working={props.working(current().id)} onClick={() => props.onCommand(current().id)} />
            : <button class="intro-hint intro-open" onClick={() => props.onSurface(current().id)}>{props.row.hint ?? "open"}</button>}
        </Show>
      </dd>
    </>
  )
}

export function IntroCard() {
  const client = useClient()
  const settings = () => client.state().settings
  const project = () => {
    const root = client.state().executionCwd ?? client.state().projectRoot
    return root === undefined ? undefined : lastSegment(root)
  }
  const identity = () => {
    const { runtimeVersion, runtimeBuildId } = client.state()
    return runtimeVersion === undefined || runtimeBuildId === undefined
      ? undefined
      : formatRuntimeIdentity({ version: runtimeVersion, buildId: runtimeBuildId }, client.state().settings?.showBuild ?? false)
  }
  const rows = () => moduleRows("intro", pageDomainReader(client.state), client.state().settings?.moduleIds)
  return (
    <div class="intro">
      <div class="intro-head">
        <Mark class="intro-mark" />
        <span class="intro-name">Flywheel</span>
        <Show when={identity()}>{(text) => <span class="intro-version">{`(${text()})`}</span>}</Show>
      </div>
      <dl class="intro-facts">
        {/* The seat in use, read the same way the composer chip reads it, so
            the card names the model and its effort the way the terminal card
            does: "model effort". */}
        <Show when={client.state().activeModel}>
          {(model) => (
            <>
              <dt>model</dt>
              <dd>
                <span>{model().model} <span class="intro-effort">{model().effort}</span></span>
                <CommandHint command="/model" verb="to change" onClick={() => client.openSheet("model")} />
              </dd>
            </>
          )}
        </Show>
        <Show when={project()}>
          {(name) => (
            <>
              <dt>project</dt>
              <dd><span title={client.state().executionCwd ?? client.state().projectRoot}>{name()}</span></dd>
            </>
          )}
        </Show>
        <Show when={client.state().branch}>
          {(branch) => (
            <>
              <dt>branch</dt>
              <dd><span>{branch()}</span></dd>
            </>
          )}
        </Show>
        <Show when={cardProfileName(settings()?.profile)}>
          {(profile) => (
            <>
              <dt>profile</dt>
              <dd><span>{profile()}</span><CommandHint command="/settings" verb="to change" onClick={() => client.openSheet("settings")} /></dd>
            </>
          )}
        </Show>
        <Key each={rows()} by="id">
          {(row) => <IntroModuleRow row={row()} onCommand={(id) => client.actions.invokeCommand(id)} working={(id) => client.actions.commandWorking(client.state().sessionId, id)} onSurface={client.openSurface} />}
        </Key>
      </dl>
    </div>
  )
}
