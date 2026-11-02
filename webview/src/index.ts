import { render } from "solid-js/web"

import { createRuntimeConnection } from "../../src/protocol/client/connection.js"
import { MINIMUM_HOST_CONTRACT_VERSION } from "../../src/protocol/client/host-contract.js"
import { createSessionChangesController } from "../../src/protocol/client/session-changes.js"
import { createComponent } from "solid-js"
import { ChangesContent } from "./app/changes-content.js"
import { App } from "./app/app.js"
import { createClientActions } from "./client/actions.js"
import { createReadingPlace } from "./client/reading-place.js"
import { createRuntimeSession } from "./client/session.js"
import { observeInputDiagnostics } from "./client/input-diagnostics.js"
import { installTouchActivation } from "./client/touch-activation.js"
import type { ClientCommand } from "../../src/protocol/client/host-contract.js"
import type { CaptureSurfaceOpener } from "../../src/protocol/client/surface-presentation.js"
import type { ClientHandle, ClientHost } from "./host.js"
import type { ComposerHandle } from "./app/composer.js"
import { checkpointOutbox, type InputReloadCheckpoint, type InputReloadStorage } from "./client/input-reload-checkpoint.js"
import { browserInputReloadStorage } from "./client/input-reload-storage.js"
import { createInputReload } from "./client/input-reload.js"
import { createInputAdmission, createInputFocus } from "./client/input-reload-dom.js"
import { prepareDocumentReplacement } from "./client/prepare-document-replacement.js"

/** Mounts the client into `root` and returns the handle a host drives.
 *
 *  This is the one entry a host calls. The connection is built from the host's
 *  transport layer, the reconciler is built over the connection, and the app
 *  renders from the reconciler; disposing the handle unwinds all three. */
export function mountClient(root: HTMLElement, host: ClientHost): ClientHandle {
  const scope = () => typeof host.inputScope === "function" ? host.inputScope() : host.inputScope ?? location.origin
  const storage = host.inputStorage ?? browserInputReloadStorage(scope)
  let mounted: ClientHandle | undefined
  let disposed = false
  const commands: ClientCommand[] = []
  void storage.load().then((bytes) => {
    if (disposed) return
    mounted = mountLoadedClient(root, host, scope, storage, bytes)
    for (const command of commands.splice(0)) mounted.command(command)
  }, () => {
    if (!disposed) root.textContent = "Flywheel could not restore this client's saved input. The saved data was kept. Reload this page to try again."
  })
  return {
    command(command) { if (mounted) mounted.command(command); else commands.push(command) },
    dispose() { disposed = true; mounted?.dispose() },
  }
}

function mountLoadedClient(root: HTMLElement, host: ClientHost, scope: () => string, storage: InputReloadStorage, checkpoint: InputReloadCheckpoint | undefined): ClientHandle {
  const diagnostic = host.onDiagnostic ?? (() => {})
  // Initial admission needs only the mounting contract. Replacement negotiates
  // its newer vocabulary separately and keeps version-1 input owners alive.
  if (host.hostContract !== undefined && !(host.hostContract >= MINIMUM_HOST_CONTRACT_VERSION)) {
    root.textContent = "This Flywheel host is older than the client the runtime serves. Update it to continue."
    diagnostic(`the host offers contract ${host.hostContract}; this client needs ${MINIMUM_HOST_CONTRACT_VERSION}`)
    return { command() {}, dispose() { root.textContent = "" } }
  }
  // A runtime that refuses this build is answered by loading the client again
  // through the host. The reader's place is saved first and restored by the
  // mount that follows, so the reload shows as nothing but the page drawing
  // again where it was.
  const readingPlace = createReadingPlace(undefined, checkpoint?.reading)
  const initialSessionId = host.initialSessionId ?? (checkpoint?.composer === undefined ? readingPlace.restored?.sessionId : checkpoint.composer.sessionId)
  let shownSession = () => initialSessionId
  const admission = createInputAdmission(root)
  const focus = createInputFocus(root, checkpoint?.focus)
  const replacementLifetime = new AbortController()
  let composer: ComposerHandle | undefined
  let pendingComposer = checkpoint?.composer
  const hadCheckpoint = checkpoint !== undefined
  const replacement = host.capabilities.replacement ?? {
    prepare: () => prepareDocumentReplacement(location.href),
    async commit() { location.reload() },
  }
  let replacementFailure: HTMLElement | undefined
  const reportReplacement = (message: string) => {
    if (replacementFailure === undefined) {
      const stack = document.createElement("div")
      stack.className = "toasts"
      replacementFailure = document.createElement("div")
      replacementFailure.className = "toast toast-warning"
      replacementFailure.setAttribute("role", "alert")
      stack.append(replacementFailure)
      root.append(stack)
    }
    replacementFailure.textContent = message
  }
  const reload = createInputReload({
    signal: replacementLifetime.signal,
    prepare: replacement.prepare,
    settled: async () => { await composer?.settled(); await admission.settled() },
    capture: () => {
      const outbox = session.unsent()
      return {
        version: 1, scope: scope(),
        composer: composer?.capture() ?? pendingComposer,
        reading: readingPlace.capture(shownSession()),
        focus: focus.capture(),
        ...(outbox.length === 0 ? {} : { outbox }),
      }
    },
    save: (value) => storage.save(value),
    hold: admission.hold,
    commit: replacement.commit,
    report: reportReplacement,
  })
  const connection = createRuntimeConnection({
    socket: host.socket,
    onDiagnostic: diagnostic,
    ...(host.clientIdentity === undefined ? {} : { clientIdentity: host.clientIdentity }),
    ...(host.capabilities.ensureRuntime === undefined ? {} : { ensureRuntime: host.capabilities.ensureRuntime }),
    onClientMismatch: () => { void reload.replace() },
  })
  const stopTouchActivation = installTouchActivation(root)
  if (host.review) {
    const target = host.review
    const controller = createSessionChangesController({ client: connection, sessionId: target.sessionId })
    root.classList.add("changes-editor")
    const openFile = host.capabilities.openFile
    const unmount = render(() => createComponent(ChangesContent, {
      controller, target,
      ...(openFile ? { onOpenFile: (path: string, executionCwd: string) => { void openFile(path, executionCwd) } } : {}),
    }), root)
    const stopInputDiagnostics = observeInputDiagnostics(root, {
      sessionId: () => target.sessionId,
      connection: () => connection.state,
      report: connection.reportDiagnostic,
    })
    void controller.start()
    return {
      command(command) { if (command.type === "reconnect") connection.reconnect() },
      dispose() { replacementLifetime.abort(); admission.dispose(); focus.dispose(); stopTouchActivation(); stopInputDiagnostics(); unmount(); controller.dispose(); void connection.close(); root.classList.remove("changes-editor") },
    }
  }
  const session = createRuntimeSession({
    initialNewChat: host.initialSessionId === undefined && checkpoint?.composer !== undefined && checkpoint.composer.sessionId === undefined,
    connection,
    unsent: checkpoint === undefined ? [] : checkpointOutbox(checkpoint),
    onDiagnostic: diagnostic,
    ...(initialSessionId === undefined ? {} : { initialSessionId }),
  })
  shownSession = () => session.sessionId ?? initialSessionId
  // The place is at least the session the page shows, or the one its address
  // opens before the first attach, so a reload for a newer client lands there.
  const savePlace = (): void => { readingPlace.save(session.sessionId ?? initialSessionId) }
  const commandListeners = new Set<(command: ClientCommand) => void>()
  const reports = new Set<(severity: "info" | "warning", message: string) => void>()
  const surfaceOpeners = new Set<CaptureSurfaceOpener>()
  const actions = createClientActions({
    session,
    connection,
    capabilities: host.capabilities,
    report: (severity, message) => {
      for (const listener of reports) listener(severity, message)
    },
    captureSurfaceOpener: () => {
      const openers = [...surfaceOpeners].map((capture) => capture())
      return (surface, sessionId, opening) => { for (const open of openers) open(surface, sessionId, opening) }
    },
  })

  // A page coming back to the foreground has usually had its socket closed
  // behind it, with or without a close event. The connection decides from the
  // lane's own evidence whether to reattach or leave a healthy lane alone.
  // A hidden page can be discarded with no further event, and an unloading
  // page is about to be loaded again, so both save the reader's place; a page
  // that comes back drops it, because a later mount in the same page, such as
  // the phone's for another project, must not open this project's session.
  const onVisible = () => {
    if (document.visibilityState !== "visible") {
      savePlace()
      return
    }
    readingPlace.forget()
    connection.resume()
  }
  const onPageHide = () => { savePlace() }
  document.addEventListener("visibilitychange", onVisible)
  addEventListener("pagehide", onPageHide)

  // The checkpoint carries the messages on their way to the next page
  // however this one goes away: a reload for a newer client, which saves the
  // whole checkpoint, but also a person's reload, a tab closed and opened
  // again, or a page the browser discards. Those run no code the page can
  // rely on, and the store is asynchronous, so the store follows the outbox
  // while the page lives. Once the page has adopted what the checkpoint
  // restored, the store holds the messages that still wait and nothing once
  // none waits. A replacement then owns the store, since its own checkpoint
  // carries the outbox. `stored` names the outbox the store holds, by
  // destination and identity, or is undefined while the store may hold
  // something else, such as the checkpoint this page restored.
  let stored: string | undefined = hadCheckpoint ? undefined : ""
  let focusAdopted = false
  const keepOutbox = (): void => {
    if ((hadCheckpoint && (pendingComposer !== undefined || !focusAdopted)) || reload.replacing) return
    const outbox = session.unsent()
    const revision = outbox.map((entry) => `${entry.sessionId}/${entry.id}`).join(" ")
    if (revision === stored) return
    const restored = stored === undefined && hadCheckpoint
    stored = revision
    void (outbox.length === 0 ? storage.consume() : storage.save({ version: 1, scope: scope(), outbox })).catch((cause: unknown) => {
      // The next change writes again, whatever this write left.
      if (stored === revision) stored = undefined
      if (restored) reportReplacement("Flywheel restored your input but could not remove its saved checkpoint.")
      else diagnostic("the waiting messages could not be saved for the next page", cause)
    })
  }
  const unmount = render(() => App({
    host,
    session,
    connection,
    actions,
    readingPlace,
    get inputCheckpoint() { return pendingComposer },
    onComposer: (handle) => { composer = handle; pendingComposer = undefined; keepOutbox() },
    onCommand: (listener) => {
      commandListeners.add(listener)
      return () => commandListeners.delete(listener)
    },
    onReport: (listener) => {
      reports.add(listener)
      return () => reports.delete(listener)
    },
    onCaptureSurfaceOpener: (listener) => {
      surfaceOpeners.add(listener)
      return () => surfaceOpeners.delete(listener)
    },
  }), root)
  focus.adopt()
  focusAdopted = true
  keepOutbox()
  const stopKeepingOutbox = session.onChange(keepOutbox)

  const stopInputDiagnostics = observeInputDiagnostics(root, {
    sessionId: () => session.sessionId,
    connection: () => connection.state,
    report: connection.reportDiagnostic,
  })

  return {
    command(command) {
      if (admission.held) return
      // The connection owns lane liveness, the same as for a page that comes
      // back to the foreground, so this command never reaches the app.
      if (command.type === "ensureConnected") {
        connection.resume()
        return
      }
      focus.dispose()
      for (const listener of commandListeners) listener(command)
    },
    dispose() {
      replacementLifetime.abort()
      admission.dispose()
      focus.dispose()
      stopTouchActivation()
      stopInputDiagnostics()
      document.removeEventListener("visibilitychange", onVisible)
      removeEventListener("pagehide", onPageHide)
      stopKeepingOutbox()
      unmount()
      actions.dispose()
      session.dispose()
      void connection.close()
    },
  }
}
