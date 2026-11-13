/** @jsxImportSource @opentui/solid */

import { createComponent, createEffect, createMemo, createRoot, getOwner, createSignal, ErrorBoundary, on, onCleanup, untrack, type Accessor, type JSX } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import { readModuleStatusRows, sameModuleStatusScope, type ModuleStatusScope } from "../../protocol/client/module-status.js"
import { moduleComposerStatus, moduleRows } from "../../protocol/modules.js"
import type { ModuleComposerStatus, ModuleRow } from "../../protocol/protocol-module.js"
import { usePaste } from "@opentui/solid"
import { createLazyTuiView } from "../components/lazy-tui-view.js"
import type { ListModalKeyEvent } from "../components/modal-list-keys.js"
import { createModalScrollController } from "../components/modal-scroll-controller.js"
import type { ModalContext, ModalHandle } from "../components/modal-stack.js"
import type { ToastInput } from "../context/toast.js"
import type { TuiComponentSurface, TuiControllerHost, TuiModule, TuiNavigation, TuiStripKeyClaim, TuiStripKeyEvent, TuiStripKeys, TuiSurface, TuiSurfaceHost } from "../tui-module.js"
import type { Keymap } from "../keymap/keymap.js"
import { normalizedPrintableText } from "../keymap/text-entry.js"
import { createDomainReader, type ModuleDomainIntakes } from "./create-module-domain-intakes.js"
import type { SurfaceRequest } from "../commands/command-surfaces.js"

const log = Log.create({ service: "module-slots" })

interface ModuleSlotDeps {
  readonly modules: readonly TuiModule[]
  readonly intakes: ModuleDomainIntakes
  readonly foregroundId: Accessor<string | undefined>
  readonly modal: Pick<ModalContext, "replace">
  readonly showToast: (toast: ToastInput) => void
  readonly client: Pick<RuntimeClient, "query" | "dispatch">
  readonly enabled?: Accessor<readonly TuiModule["id"][] | undefined>
  /** Whether the runtime answers this terminal now; a held module view reads
   *  as current only while it does. */
  readonly answering: Accessor<boolean>
  readonly auth?: TuiControllerHost["auth"]
  readonly projectRoot?: Accessor<string>
  readonly navigate: TuiNavigation
  readonly clipboard: TuiControllerHost["clipboard"]
  readonly appVersion?: string
  /** The effective keymap, whose bindings win over the chords a strip declares. */
  readonly keymap?: Pick<Keymap, "commandAt">
  /** Reports a config mistake, such as a strip chord the keymap binds. */
  readonly reportIssue?: (message: string) => void
  /** The prompt a strip gives its focus back to. */
  readonly composer?: { readonly hasDraft: (sessionId: string) => boolean; readonly syncFocus: () => void }
  /** Whether the foreground's own question shows; its dock then owns the keys. */
  readonly foregroundQuestion?: Accessor<boolean>
}

interface StripKeyEventLike extends TuiStripKeyEvent { readonly preventDefault?: () => void }

export interface ModuleSlots {
  /** The rows every module contributes to the welcome card, the status
   *  modal, and Settings, for the foreground session, in registry order. */
  readonly composerStatus: Accessor<readonly ModuleComposerStatus[]>
  readonly introRows: Accessor<readonly ModuleRow[]>
  readonly statusRows: Accessor<readonly ModuleRow[]>
  readonly settingsRows: Accessor<readonly ModuleRow[]>
  readonly refreshStatus: () => void
  /** Every module strip for one session, in registry order. */
  readonly Strips: (props: { readonly sessionId: string; readonly width: Accessor<number> }) => JSX.Element
  /** One opener per surface id. Controllers recheck optional presentation
   *  intent after loading and receive the opening command's argument. Each
   *  opener answers whether the surface accepted the opening. */
  readonly surfaces: ReadonlyMap<string, (request?: SurfaceRequest) => boolean | Promise<boolean>>
  /** True while a strip holds key focus, so the composer has none. */
  readonly stripFocused: Accessor<boolean>
  /** Offers a normalized key to the strips; true when a strip owned it. */
  readonly stripInput: (event: StripKeyEventLike) => boolean
  /** Ends strip focus and gives the prompt its focus now: a printable key the
   *  strip did not take, a paste, and a press on the prompt call it. */
  readonly releaseStripFocus: () => void
}

/** The terminal's one slot host (ARCH-PROTOCOL-034). It renders every registered
 *  module's strips and surfaces, runs every presence hook once, and reads
 *  every module's rows from one `DomainReader` over the intakes, and it names
 *  no module. A render failure in one module's slot is contained to that slot
 *  and reported once, so a broken module never takes the composer with it. */
export function createModuleSlots(deps: ModuleSlotDeps): ModuleSlots {
  const foreground = createDomainReader(deps.intakes, deps.foregroundId, deps.answering)
  const composerStatus = createMemo(() => moduleComposerStatus(foreground, deps.enabled?.()))
  const introRows = createMemo(() => moduleRows("intro", foreground, deps.enabled?.()))
  const settingsRows = createMemo(() => moduleRows("settings", foreground, deps.enabled?.()))
  const enabled = (module: TuiModule): boolean => deps.enabled?.()?.includes(module.id) ?? true
  const statusScope = createMemo<ModuleStatusScope, undefined>(() => ({ sessionId: deps.foregroundId(), profileId: deps.auth?.()?.profile.id, moduleIds: deps.enabled?.() ?? deps.modules.map((module) => module.id) }), undefined, { equals: sameModuleStatusScope })
  const [queriedRows, setQueriedRows] = createSignal<{ readonly scope: ModuleStatusScope; readonly rows: readonly ModuleRow[] }>()
  const statusRows = createMemo(() => {
    const result = queriedRows()
    return [...moduleRows("status", foreground, deps.enabled?.()), ...(result?.scope === statusScope() ? result.rows : [])]
  })
  let statusGeneration = 0
  function refreshStatus(): void {
    const generation = ++statusGeneration
    const scope = statusScope()
    const current = (): boolean => generation === statusGeneration && statusScope() === scope
    setQueriedRows(undefined)
    void readModuleStatusRows(deps.modules, scope, (module, sessionId) => module.status?.({ client: deps.client, foregroundId: () => sessionId }), (module, error) => {
      if (untrack(current)) contain(module, "status", error)
    }, deps.answering).then((rows) => { if (untrack(current)) setQueriedRows({ scope, rows }) })
  }
  createEffect(on(statusScope, () => { statusGeneration += 1; setQueriedRows(undefined) }, { defer: true }))
  onCleanup(() => { statusGeneration += 1 })

  function contain(module: TuiModule, slot: string, error: unknown): void {
    log.error("module slot render failed", { module: module.id, slot, error: errorMessage(error) })
    deps.showToast({ message: `The ${module.id} module could not render its ${slot}: ${errorMessage(error)}`, variant: "error" })
  }

  for (const module of deps.modules) {
    try {
      module.present?.({ read: foreground, showToast: deps.showToast })
    } catch (error) {
      contain(module, "presence", error)
    }
  }

  const surfaces = new Map(deps.modules.flatMap((module) => (module.surfaces ?? []).map((surface) => [surface.id, createSurfaceOpener(module, surface)] as const)))
  const openSurface = (id: string): void => { surfaces.get(id)?.() }

  function createSurfaceOpener(module: TuiModule, surface: TuiSurface): (request?: SurfaceRequest) => boolean | Promise<boolean> {
    if ("loadController" in surface) return controlledSurfaceOpener(module, surface)
    return componentSurfaceOpener(module, surface)
  }

  function controlledSurfaceOpener(module: TuiModule, surface: Extract<TuiSurface, { readonly loadController: unknown }>): (request?: SurfaceRequest) => boolean | Promise<boolean> {
    const owner = getOwner()
    let alive = true
    let generation = 0
    let dispose: (() => void) | undefined
    let open: ((argument?: string) => void | Promise<boolean>) | undefined
    let pending: Promise<void> | undefined
    // The latest opening that waits for the controller. A later one replaces
    // it, and the replaced one settles as accepted: the person moved on.
    let pendingPresentation: { readonly request: SurfaceRequest; readonly settle: (accepted: boolean) => void } | undefined
    const clear = (): void => { generation += 1; dispose?.(); dispose = undefined; open = undefined; pending = undefined; pendingPresentation?.settle(false); pendingPresentation = undefined }
    createEffect(on(() => enabled(module), (active) => { if (!active) clear() }))
    onCleanup(() => { alive = false; clear() })
    const present = async (opener: (argument?: string) => void | Promise<boolean>, request: SurfaceRequest): Promise<boolean> =>
      !request.isCurrent || request.isCurrent() ? (await opener(request.argument)) !== false : true
    return (presentation = {}) => {
      if (!enabled(module)) return false
      if (open) return present(open, presentation)
      const accepted = Promise.withResolvers<boolean>()
      pendingPresentation?.settle(true)
      pendingPresentation = { request: presentation, settle: accepted.resolve }
      if (pending) return accepted.promise
      const request = generation
      pending = surface.loadController().then(async (create) => {
        if (!alive || request !== generation || !enabled(module)) return
        const opened = createRoot((release) => {
          dispose = release
          return create({ enabled: () => enabled(module), modal: deps.modal, client: deps.client, foregroundId: deps.foregroundId, auth: deps.auth ?? (() => undefined), read: foreground, projectRoot: deps.projectRoot ?? (() => ""), showToast: deps.showToast, navigate: deps.navigate, clipboard: deps.clipboard, appVersion: deps.appVersion ?? "" })
        }, owner)
        open = opened
        const current = pendingPresentation
        pendingPresentation = undefined
        if (current) current.settle(await present(opened, current.request))
      }).catch((error: unknown) => {
        contain(module, surface.id, error)
        pendingPresentation?.settle(false)
        pendingPresentation = undefined
      }).finally(() => { if (request === generation) pending = undefined })
      return accepted.promise
    }
  }

  function componentSurfaceOpener(module: TuiModule, surface: TuiComponentSurface): () => boolean {
    const [sessionId, setSessionId] = createSignal<string | undefined>()
    const scroll = createModalScrollController()
    // The reader follows the session captured at open, so the surface and its
    // key handler read one session's views for the whole time it is up.
    const read = createDomainReader(deps.intakes, sessionId, deps.answering)
    let handle: ModalHandle | undefined
    const close = (): void => {
      handle?.close()
      handle = undefined
      setSessionId(undefined)
    }
    const host: TuiSurfaceHost = { read, client: deps.client, navigate: deps.navigate, showToast: deps.showToast, scroll, close }
    const onKey = surfaceKeys(surface, host)
    const View = createLazyTuiView(surface.title, surface.load, (error) => {
      contain(module, surface.title, error)
      // The failure lands mid-paint of the modal itself; the stack changes on the next tick.
      queueMicrotask(close)
      return null
    })
    // The surface shows the session that was in front when it opened and
    // closes when the foreground moves, so it never shows another session's rows.
    function open(): void {
      const id = deps.foregroundId()
      if (id === undefined || !enabled(module)) return
      close()
      scroll.reset()
      setSessionId(id)
      handle = deps.modal.replace(() => createComponent(View, { sessionId: id, read, client: deps.client, navigate: deps.navigate, showToast: deps.showToast, scroll, width: surface.width, controls: surface.controls, onClose: close }), {
        onKey,
        onClose: () => { scroll.detach(); setSessionId(undefined) },
      })
    }
    createEffect(on(deps.foregroundId, (current) => {
      const captured = sessionId()
      if (captured !== undefined && current !== captured) close()
    }, { defer: true }))
    createEffect(on(() => enabled(module), (active) => { if (!active) close() }))
    onCleanup(close)
    return () => { open(); return true }
  }

  interface StripClaim { readonly onKey: (event: TuiStripKeyEvent) => boolean }
  // Claims in mount order, which is registry order; read only when a key arrives.
  const claims: StripClaim[] = []
  const [focusedClaim, setFocusedClaim] = createSignal<StripClaim>()
  const stripFocused = (): boolean => focusedClaim() !== undefined
  const reportedConflicts = new Set<string>()
  createEffect(on(deps.foregroundId, () => setFocusedClaim(undefined), { defer: true }))
  createEffect(on(() => deps.foregroundQuestion?.() ?? false, (shows) => { if (shows) setFocusedClaim(undefined) }))

  function stripKeys(module: TuiModule): TuiStripKeys {
    return {
      claim(input) {
        const claim: StripClaim = { onKey: input.onKey }
        claims.push(claim)
        onCleanup(() => {
          claims.splice(claims.indexOf(claim), 1)
          if (untrack(focusedClaim) === claim) setFocusedClaim(undefined)
        })
        // Reruns when a [keybindings] publication changes the effective keymap.
        createEffect(() => {
          for (const chord of input.chords) {
            const command = deps.keymap?.commandAt(chord)
            const conflict = `${module.id}:${chord}:${command}`
            if (!command || reportedConflicts.has(conflict)) continue
            reportedConflicts.add(conflict)
            deps.reportIssue?.(`The ${module.id} module's key "${chord}" is bound to the command "${command}", which keeps it. Bind "${command}" to another key in [keybindings] to free "${chord}".`)
          }
        })
        const handle: TuiStripKeyClaim = {
          focused: () => focusedClaim() === claim,
          setFocused: (next) => {
            if (next && !(untrack(() => deps.foregroundQuestion?.()) ?? false)) setFocusedClaim(() => claim)
            else if (!next && untrack(focusedClaim) === claim) setFocusedClaim(undefined)
          },
        }
        return handle
      },
    }
  }

  // The one way strip focus goes back to the prompt. The prompt takes focus
  // in this dispatch, and the renderer offers the current key or paste to the
  // focused prompt after every global listener, so the input that ended strip
  // focus, and the rest of its stdin chunk, lands in the prompt itself.
  function releaseStripFocus(): void {
    setFocusedClaim(undefined)
    deps.composer?.syncFocus()
  }

  // A strip with focus owns every key that reaches it, so Escape never
  // interrupts from the list; only a printable key leaves it for the prompt.
  function stripInput(event: StripKeyEventLike): boolean {
    const holder = untrack(focusedClaim)
    if (holder) {
      if (holder.onKey(event)) { event.preventDefault?.(); return true }
      if (normalizedPrintableText(event) !== null) releaseStripFocus()
      return true
    }
    for (const claim of claims) {
      if (claim.onKey(event)) { event.preventDefault?.(); return true }
    }
    return false
  }

  function Strips(props: { readonly sessionId: string; readonly width: Accessor<number> }): JSX.Element {
    // A paste that no overlay or question took goes to the prompt, which has
    // no focus while a strip holds it.
    usePaste((event) => { if (!event.defaultPrevented && untrack(focusedClaim)) releaseStripFocus() })
    return deps.modules.flatMap((module) => {
      const strip = module.strip
      if (!strip) return []
      const read = createDomainReader(deps.intakes, () => props.sessionId, deps.answering)
      const composer = { empty: () => !(deps.composer?.hasDraft(props.sessionId) ?? false) }
      return [(
        <ErrorBoundary fallback={(error: unknown) => { contain(module, "strip", error); return null }}>
          {createComponent(strip, { sessionId: props.sessionId, read, width: props.width, openSurface, keys: stripKeys(module), composer })}
        </ErrorBoundary>
      )]
    })
  }

  return { composerStatus, introRows, statusRows, settingsRows, refreshStatus, Strips, surfaces, stripFocused, stripInput, releaseStripFocus }
}

/** The keys every surface answers: the surface's own handler first, then
 *  scroll and close. Exported so the vocabulary is testable without a modal. */
export function surfaceKeys(surface: TuiComponentSurface, host: TuiSurfaceHost): (event: ListModalKeyEvent) => void {
  return (event) => {
    if (surface.onKey?.(event, host)) return
    const key = event.name.toLowerCase()
    if (key === "escape" || key === "q") {
      event.preventDefault?.()
      host.close()
      return
    }
    if (key === "up" || key === "k" || key === "down" || key === "j") {
      event.preventDefault?.()
      host.scroll.scrollBy(key === "up" || key === "k" ? -1 : 1)
      return
    }
    if (key === "pageup" || key === "u" || key === "pagedown" || key === "d") {
      event.preventDefault?.()
      host.scroll.pageBy(key === "pageup" || key === "u" ? -1 : 1)
      return
    }
    if (key === "g") {
      event.preventDefault?.()
      // The scrollbox clamps the row target, so the largest safe integer is "bottom".
      host.scroll.scrollTo(event.shift === true || event.sequence === "G" ? Number.MAX_SAFE_INTEGER : 0)
    }
  }
}
