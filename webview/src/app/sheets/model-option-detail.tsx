import { Index, Show } from "solid-js"
import type { ModelOptionRow } from "../../../../src/protocol/model-assignment-protocol-types.js"

/** The one-line detail of a model picker row: the providers in resolution order up to the one that would serve now,
 *  which is emphasized, then a count of the providers after it, then `parts`. When no provider serves now, every
 *  provider shows and none is emphasized. The line never wraps, so a phone row keeps two lines (PI-MODEL-015).
 *  Mount it once per row and pass reactive props: a refresh then patches its text in place, because each refresh
 *  delivers new provider objects with the same values (PI-INTERACTION-062). */
export function ModelOptionDetail(props: { readonly providers: ModelOptionRow["providers"]; readonly parts: readonly (string | undefined)[] }) {
  const servingIndex = () => props.providers.findIndex((provider) => provider.serving)
  const shown = () => servingIndex() < 0 ? props.providers : props.providers.slice(0, servingIndex() + 1)
  const after = () => props.providers.length - shown().length
  const parts = () => props.parts.filter((part): part is string => part !== undefined && part.length > 0).join(" · ")
  return (
    <span class="model-option-detail">
      <Index each={shown()}>
        {(provider, index) => <>{index === 0 ? "" : " → "}<span class={provider().serving ? "model-option-serving" : undefined}>{provider().shortName}</span></>}
      </Index>
      <Show when={after() > 0}>{` +${after()}`}</Show>
      <Show when={shown().length > 0 && parts().length > 0}>{" · "}</Show>
      {parts()}
    </span>
  )
}
