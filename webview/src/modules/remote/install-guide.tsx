import { createSignal, For, Show } from "solid-js"

import type { InstallGuide as InstallGuideSnapshot, InstallStep } from "../../host.js"
import "./install-guide.css"

/** The step after pairing: put the app on the Home Screen.
 *
 *  A phone that only ever opens this page in a browser tab never receives a
 *  notification, and the person cannot know that from a tab that looks like it
 *  works. So the moment a machine is paired, this card shows the taps the
 *  host's platform needs, animated as a loop that lifts each tap in turn, the
 *  way a person would perform them. The host names the taps; the client draws
 *  them, so the card never guesses which browser it is in. Reduced motion
 *  shows the same steps as a numbered strip that does not move. */

const DISMISSED_KEY = "flywheel.install-guide.dismissed"
/** How long each tap holds the spotlight in the loop. */
const STEP_MS = 1800

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1"
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1")
  } catch {
    // A browser that refuses storage shows the card again next time, which is
    // the right failure: it errs towards the person seeing the step.
  }
}

/** One glyph per tap, drawn in the host's foreground so it reads on every theme. */
function Glyph(props: { readonly glyph: InstallStep["glyph"] }) {
  return (
    <svg class="install-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.glyph === "share" && <><path d="M12 15V4" /><path d="M8.5 7.5L12 4l3.5 3.5" /><path d="M6.5 10.5H6a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2h-.5" /></>}
      {props.glyph === "add-home" && <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8.5v7M8.5 12h7" /></>}
      {props.glyph === "confirm" && <path d="M5 12.5l4.5 4.5L19 7.5" />}
      {props.glyph === "menu" && <><circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" /></>}
      {props.glyph === "install" && <><path d="M12 4v11" /><path d="M8 11l4 4 4-4" /><path d="M5 19h14" /></>}
      {props.glyph === "dock" && <><rect x="3.5" y="15" width="17" height="4.5" rx="1.5" /><rect x="9" y="5" width="6" height="6" rx="1.5" /><path d="M12 11v4" /></>}
    </svg>
  )
}

export function InstallGuide(props: { readonly guide: InstallGuideSnapshot; readonly onPrompt?: () => Promise<boolean>; readonly forceVisible?: boolean; readonly onDismiss?: () => void }) {
  const [dismissed, setDismissed] = createSignal(readDismissed())
  const [busy, setBusy] = createSignal(false)
  const prompt = async () => {
    if (!props.onPrompt) return
    setBusy(true)
    try {
      if (await props.onPrompt()) setDismissed(true)
    } finally {
      setBusy(false)
    }
  }
  const later = () => {
    if (!props.forceVisible) writeDismissed()
    setDismissed(true)
    props.onDismiss?.()
  }
  const cycle = () => `${props.guide.steps.length * STEP_MS}ms`
  return (
    <Show when={props.forceVisible || !dismissed()}>
      <section class="install-guide" aria-labelledby="install-title">
        <div class="install-text">
          <h3 class="install-title" id="install-title">Put Flywheel on your Home Screen</h3>
          <p class="install-lead">Notifications reach the installed app, and it opens full screen. A browser tab does neither.</p>
        </div>
        <Show when={props.guide.note}>{(note) => <p class="install-note">{note()}</p>}</Show>
        <Show when={props.guide.steps.length > 0}>
          <div class="install-browser">In {props.guide.browser}</div>
        </Show>
        <ol class="install-steps" style={{ "--install-cycle": cycle() }}>
          <For each={props.guide.steps}>
            {(step, index) => (
              <li class="install-step" style={{ "--install-delay": `${index() * STEP_MS}ms` }}>
                <span class="install-tile" aria-hidden="true">
                  <span class="install-ring" />
                  <Glyph glyph={step.glyph} />
                </span>
                <span class="install-label"><span class="install-number">{index() + 1}</span>{step.label}</span>
              </li>
            )}
          </For>
        </ol>
        <div class="install-actions">
          <button class="ghost-text" onClick={later}>Later</button>
          <Show when={props.guide.canPrompt && props.onPrompt}>
            <button class="primary" disabled={busy()} onClick={() => { void prompt() }}>{busy() ? "Installing…" : "Install"}</button>
          </Show>
        </div>
      </section>
    </Show>
  )
}
