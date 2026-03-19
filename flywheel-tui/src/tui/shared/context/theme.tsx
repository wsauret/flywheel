/** @jsxImportSource solid-js */
import { createMemo, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import flywheelTheme from "./theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "./theme/resolve"
import { generateSyntax } from "./syntax-rules"

export type { Theme } from "./theme/resolve"
export { resolveTheme } from "./theme/resolve"

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { mode: "dark" | "light" }) => {
    // Use signal so theme can be changed dynamically
    const [mode, setMode] = createSignal(props.mode)
    const theme = createMemo(() => resolveTheme(flywheelTheme as any, mode()))
    const syntax = createMemo(() => {
      const s = generateSyntax(theme())
      onCleanup(() => s.destroy())
      return s
    })

    return {
      get theme() {
        return theme()
      },
      get mode() {
        return mode()
      },
      get syntax() {
        return syntax()
      },
      setMode,
    }
  },
})
