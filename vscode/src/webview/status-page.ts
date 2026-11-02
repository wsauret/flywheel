import type { RuntimeTransportHealth } from "../../../src/protocol/app-service-types.js"
import { runtimeFaultCopy, startRefusalCopy } from "../../../src/protocol/client/runtime-fault-copy.js"
import { describeInstallFailure } from "../runtime/bootstrap-install.js"
import type { HostFailure, HostPhase } from "../runtime/host-lifecycle.js"
import { describeResolveFailure } from "../runtime/runtime-resolver.js"
import { describeStartFailure } from "../runtime/supervisor.js"

/** What the panel shows while there is no client to show: the editor is
 *  installing or starting Flywheel, or it cannot, and says why.
 *
 *  Each page states one cause in the same words the log uses, and offers only
 *  the actions that remedy that cause: a bad setting offers the setting, a
 *  missing install offers the install guide, a start that failed offers to
 *  try again. A page says that Flywheel starts on its own only where it does.
 *  Every action is reversible. */
export interface StatusPage {
  readonly title: string
  readonly body: string
  readonly actions: readonly PageAction[]
  /** Flywheel is working toward a client; the page shows progress. */
  readonly busy?: true
  /** A start that has no bound: once it has waited `STILL_STARTING_AFTER_MS`
   *  the page shows `notice`, with `{waited}` filled by the page as the wait
   *  grows, and keeps waiting. */
  readonly waiting?: { readonly since: number; readonly notice: string }
}

/** How long a start waits before its page says that it is still starting. */
export const STILL_STARTING_AFTER_MS = 15_000

/** What a long start's page says. `serve ensure` is not cut short, because a
 *  slow service-manager restart or a busy cutover ends on its own, so the page
 *  says what the start waits for and how long it has waited instead. */
export function stillStartingNotice(step: string | undefined): string {
  // The page's body already names the step, so the notice points at it.
  const waitsFor = step === undefined ? "Flywheel's background service to answer" : "the step above"
  return `Flywheel is still starting after {waited}. It waits for ${waitsFor}. The editor keeps waiting and does not stop the start. Show the log lists each step.`
}

export type PageActionId = "log" | "retry" | "openFolder" | "executableSetting" | "projectRootSetting" | "installGuide" | "showExtension"

interface PageAction {
  readonly id: PageActionId
  readonly label: string
  readonly primary?: true
}

const LOG: PageAction = { id: "log", label: "Show the log" }
const RETRY: PageAction = { id: "retry", label: "Try again", primary: true }
const STARTS_ON_CHANGE = "Flywheel starts on its own once the setting changes."
/** The remedy for a start that failed with no remedy of its own. */
const START_AGAIN = "Choose Try again to start Flywheel again. Show the log lists each step the start took."

/** The page for every phase that is not a client. */
export function statusPage(phase: Exclude<HostPhase, { readonly kind: "ready" }>): StatusPage {
  switch (phase.kind) {
    case "starting":
      return {
        title: "Starting Flywheel",
        body: phase.label ?? "Finding or starting Flywheel's background service.",
        actions: [LOG],
        busy: true,
        ...(phase.since === undefined ? {} : { waiting: { since: phase.since, notice: stillStartingNotice(phase.label) } }),
      }
    case "installing":
      return {
        title: "Installing Flywheel",
        body: "Flywheel is not on this machine yet, so the extension is installing the current release. This usually takes under a minute, and Flywheel starts when it is done.",
        actions: [{ id: "log", label: "Show progress" }],
        busy: true,
      }
    case "unavailable":
      return failurePage(phase.failure)
  }
}

function failurePage(failure: HostFailure): StatusPage {
  switch (failure.kind) {
    case "no_folder":
      return {
        title: "Open a folder to use Flywheel",
        body: "Flywheel works on a project, so it needs a folder open. Open the folder you want to work in, and Flywheel starts on its own.",
        actions: [{ id: "openFolder", label: "Open a folder", primary: true }],
      }
    case "resolve": {
      const body = describeResolveFailure(failure.failure)
      if (failure.failure.kind === "setting_unusable") {
        return { title: "Check the Flywheel path setting", body: `${body} ${STARTS_ON_CHANGE}`, actions: [{ id: "executableSetting", label: "Open the setting", primary: true }, LOG] }
      }
      return failure.failure.source === "setting"
        ? { title: "Flywheel needs an update", body: `${body} ${STARTS_ON_CHANGE}`, actions: [{ id: "executableSetting", label: "Point at a newer build", primary: true }, LOG] }
        : updatePage(body)
    }
    case "install":
      return failure.failure.kind === "launcher_too_old"
        ? { title: "Flywheel needs an update", body: describeInstallFailure(failure.failure), actions: [RETRY, LOG] }
        : { title: "Flywheel could not be installed", body: describeInstallFailure(failure.failure), actions: [RETRY, { id: "installGuide", label: "Install Flywheel by hand" }, LOG] }
    case "start":
      return startFailurePage(failure.failure)
    case "client":
      return {
        title: "Flywheel's background service did not answer",
        body: `The panel could not reach Flywheel's background service to load its client (${failure.detail}). This page goes away on its own once the service answers again.`,
        actions: [RETRY, LOG],
      }
  }
}

function startFailurePage(failure: Extract<HostFailure, { readonly kind: "start" }>["failure"]): StatusPage {
  const body = describeStartFailure(failure)
  switch (failure.kind) {
    case "project_root_missing":
      return { title: "Check the Flywheel project setting", body: `${body} ${STARTS_ON_CHANGE}`, actions: [{ id: "projectRootSetting", label: "Open the setting", primary: true }, LOG] }
    case "executable_missing":
      return { title: "Flywheel could not start", body, actions: [RETRY, { id: "executableSetting", label: "Point at an existing install" }, LOG] }
    case "version_unsupported":
      return updatePage(body)
    case "protocol_unsupported":
      return failure.version === undefined || failure.version < failure.required
        ? updatePage(body)
        : { title: "Update the Flywheel extension", body, actions: [{ id: "showExtension", label: "Show the extension", primary: true }, LOG] }
    case "startup_failed":
      return { title: failure.refusal === undefined ? "Flywheel could not start" : startRefusalCopy(failure.refusal).title, body: failure.refusal === undefined ? `${body}\n${START_AGAIN}` : startRefusalCopy(failure.refusal).remedy, actions: [RETRY, LOG] }
    case "no_endpoint":
    case "exited":
      return { title: "Flywheel could not start", body: `${body}\n${START_AGAIN}`, actions: [RETRY, LOG] }
  }
}

/** An installed Flywheel older than this extension: the person updates it in
 *  a terminal, then asks again here. */
function updatePage(body: string): StatusPage {
  return { title: "Flywheel needs an update", body, actions: [{ id: "installGuide", label: "How to update Flywheel", primary: true }, { id: "retry", label: "Try again" }, LOG] }
}

export interface StatusReading {
  /** A codicon id. */
  readonly icon: string
  readonly sentence: string
}

/** The status bar item: an icon and one sentence. It names the same cause
 *  as the panel and points at it, so a failure is stated in one place. A
 *  runtime that recovers is not a state of its own: the item stays as it was
 *  until the connection reports a fault (PI-INTERACTION-036). */
export function statusReading(phase: HostPhase, health: RuntimeTransportHealth | undefined): StatusReading {
  switch (phase.kind) {
    case "starting":
    case "installing":
      return { icon: "loading~spin", sentence: phase.kind === "installing" ? "Installing Flywheel" : phase.label ?? "Starting Flywheel" }
    case "unavailable":
      return { icon: phase.failure.kind === "no_folder" ? "circle-slash" : "error", sentence: statusPage(phase).title }
    case "ready": {
      if (health?.kind !== "faulted") return { icon: "zap", sentence: `Connected to Flywheel ${phase.runtime.version}` }
      const copy = runtimeFaultCopy(health)
      return { icon: copy.tone === "fault" ? "error" : "warning", sentence: copy.title }
    }
  }
}

/** The page as a document. Scripts run only to post an action's id. */
export function statusPageHtml(page: StatusPage, nonce: string): string {
  const actions = page.actions
    .map((action) => `<button class="${action.primary === true ? "primary" : "secondary"}" data-action="${action.id}">${escapeHtml(action.label)}</button>`)
    .join("")
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Flywheel</title>
<style>
  body {
    margin: 0;
    padding: 32px 24px;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.55;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 12px; overflow-wrap: anywhere; }
  p {
    margin: 0 0 12px;
    color: var(--vscode-descriptionForeground);
    max-width: 44ch;
    /* A cause can carry a process's last lines and a long path: keep its
       breaks and wrap anywhere rather than run past the panel's edge. */
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .progress { height: 2px; max-width: 44ch; margin: 0 0 16px; overflow: hidden; background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); }
  .progress::after { content: ""; display: block; width: 30%; height: 100%; background: var(--vscode-progressBar-background); animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) { .progress::after { animation: none; width: 100%; opacity: 0.4; } }
  .actions { display: flex; flex-direction: column; gap: 4px; margin-top: 16px; max-width: 44ch; }
  button {
    font-family: inherit;
    font-size: 12px;
    padding: 7px 12px;
    text-align: left;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
  }
  .primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary {
    background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent);
    color: var(--vscode-foreground);
  }
  .secondary:hover { background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); }
</style>
</head>
<body>
<h1>${escapeHtml(page.title)}</h1>
${page.busy === true ? `<div class="progress" role="progressbar" aria-label="${escapeHtml(page.title)}"></div>` : ""}
<p role="status">${escapeHtml(page.body)}</p>
${page.waiting === undefined ? "" : `<p role="status" id="waiting" hidden data-since="${page.waiting.since}" data-after="${STILL_STARTING_AFTER_MS}" data-notice="${escapeHtml(page.waiting.notice)}"></p>`}
<div class="actions">${actions}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  for (const button of document.querySelectorAll("button")) {
    button.addEventListener("click", () => vscode.postMessage({ type: "pageAction", id: button.dataset.action }))
  }
  // The wait grows while the page stays, so the page fills it in. It moves
  // in steps of the first notice's delay, so a screen reader hears each
  // step once rather than every second.
  const waiting = document.getElementById("waiting")
  if (waiting) {
    const since = Number(waiting.dataset.since)
    const after = Number(waiting.dataset.after)
    const count = (n, unit) => n + " " + unit + (n === 1 ? "" : "s")
    const waited = (ms) => {
      const seconds = Math.floor(ms / after) * after / 1000
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      return minutes === 0 ? count(rest, "second") : rest === 0 ? count(minutes, "minute") : count(minutes, "minute") + " " + count(rest, "second")
    }
    const tick = () => {
      const ms = Date.now() - since
      if (ms < after) return
      const text = waiting.dataset.notice.replace("{waited}", waited(ms))
      if (waiting.textContent !== text) waiting.textContent = text
      waiting.hidden = false
    }
    tick()
    setInterval(tick, 1000)
  }
</script>
</body>
</html>`
}

// The page interpolates a path the user wrote and text a subprocess printed,
// so every value is escaped like any other untrusted text.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
