import { render } from "solid-js/web"

import { BrandTile } from "../src/app/icons.js"

/** Why this page cannot reach the project: it holds no token, or the one it
 *  holds no longer opens the runtime at this origin. */
export type GateReason = "missing" | "refused"

/** The page a browser sees when it has no way into the project: the brand,
 *  one sentence on what happened, and the one command that opens the project
 *  with a fresh link. It replaces the client wholesale, because until the
 *  page holds a token there is nothing behind it a person could use. */
function Gate(props: { readonly reason: GateReason }) {
  return (
    <div class="client">
      <div class="pane">
        <div class="stage stage-starting" role="status" aria-label="Flywheel needs its link">
          <BrandTile size={96} />
          <div class="stage-title">Flywheel</div>
          <p class="stage-body">
            {props.reason === "missing"
              ? "This tab has no key to the project."
              : "The link this tab used no longer opens this project."}
          </p>
          <p class="stage-body">
            In the project's terminal, run <code>flywheel web</code> and the browser opens with a fresh link.
          </p>
        </div>
      </div>
    </div>
  )
}

/** Shows the gate in `root`, replacing whatever was there. */
export function showGate(root: HTMLElement, reason: GateReason): void {
  root.replaceChildren()
  render(() => <Gate reason={reason} />, root)
}
