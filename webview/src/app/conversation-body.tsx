import type { Accessor, JSX } from "solid-js"

import type { ConversationInput } from "../web-module-client.js"
import { Composer, type ComposerHandle } from "./composer.js"
import { Transcript } from "./transcript.js"

/** The resident ordinary session body. The caller supplies its header and
 *  admitted input address without replacing transcript or composer ownership.
 *  Visibility keeps both mounted while a workflow surface covers them. */
export function ConversationBody(props: {
  readonly header?: JSX.Element
  readonly transcriptHidden?: boolean
  readonly composerHidden?: boolean
  readonly phoneSelection?: boolean
  readonly register: (handle: ComposerHandle) => void
  readonly input?: Accessor<ConversationInput | undefined>
}) {
  return (
    <>
      {props.header}
      <div class="transcript-slot" classList={{ "hidden-for-workflow": props.transcriptHidden }}>
        <Transcript phoneSelection={props.phoneSelection} />
      </div>
      <div class="composer-slot" classList={{ "hidden-for-workflow": props.composerHidden }}>
        <Composer register={props.register} input={props.input} />
      </div>
    </>
  )
}
