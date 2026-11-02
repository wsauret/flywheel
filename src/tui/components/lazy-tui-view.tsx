/** @jsxImportSource @opentui/solid */

import { createComponent, createSignal, ErrorBoundary, onCleanup, onMount, Show, type Component, type JSX } from "solid-js"
import type { TuiTheme } from "../context/theme/resolve.js"
import { useTheme } from "../context/theme.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { OpaqueBox } from "./opaque-box.js"

const log = Log.create({ service: "lazy-tui-view" })

interface LazyTuiViewChrome {
  title: string
  theme: TuiTheme
}

function LoadingView(props: LazyTuiViewChrome): JSX.Element {
  return (
    <OpaqueBox flexDirection="column" borderColor={props.theme.primary} border={["top", "bottom", "left", "right"]} borderStyle="rounded" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <text fg={props.theme.primary}>{props.title}</text>
      <box height={1} />
      <text fg={props.theme.textMuted}>Loading...</text>
      <text fg={props.theme.textMuted}>Esc closes.</text>
    </OpaqueBox>
  )
}

function LoadFailureView(props: LazyTuiViewChrome): JSX.Element {
  return (
    <OpaqueBox flexDirection="column" borderColor={props.theme.error} border={["top", "bottom", "left", "right"]} borderStyle="rounded" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
      <text fg={props.theme.error}>{props.title}</text>
      <box height={1} />
      <text fg={props.theme.error}>Could not load this view.</text>
      <text fg={props.theme.textMuted}>Close and reopen to retry, or restart Flywheel.</text>
      <text fg={props.theme.textMuted}>Esc closes.</text>
    </OpaqueBox>
  )
}

/** Lazily loads one TUI component and owns its shared import and mount
 *  lifetime. A render failure shows the failure view unless the caller
 *  supplies its own containment. */
export function createLazyTuiView<P extends object>(title: string, load: () => Promise<Component<P> | undefined>, renderFailure?: (error: unknown) => JSX.Element): Component<P> {
  let cached: Component<P> | undefined
  let pending: Promise<Component<P>> | undefined

  return (props) => {
    const { theme } = useTheme()
    const [Loaded, setLoaded] = createSignal<Component<P> | undefined>(cached)
    const [failed, setFailed] = createSignal(false)
    let mounted = true

    onMount(() => {
      if (!cached) pending ??= Promise.resolve().then(load).then((component) => {
        if (typeof component !== "function") throw new Error("TUI view module did not export a component")
        cached = component
        return component
      }).catch((error: unknown) => {
        pending = undefined
        log.error("TUI view module load failed", { error: errorMessage(error) })
        throw error
      })
      void pending?.then(
        (component) => {
          if (mounted) setLoaded(() => component)
        },
        () => {
          if (mounted) setFailed(true)
        },
      )
    })

    onCleanup(() => {
      mounted = false
    })

    return (
      <Show
        when={Loaded()}
        fallback={(
          <Show when={failed()} fallback={<LoadingView title={title} theme={theme} />}>
            <LoadFailureView title={title} theme={theme} />
          </Show>
        )}
      >
        {(Resolved) => (
          <ErrorBoundary fallback={(error: unknown) => {
            log.error("TUI view render failed", { error: errorMessage(error) })
            return renderFailure ? renderFailure(error) : <LoadFailureView title={title} theme={theme} />
          }}>
            {createComponent(Resolved(), props)}
          </ErrorBoundary>
        )}
      </Show>
    )
  }
}
