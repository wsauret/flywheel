// OpenTUI accepts `selectable` on every renderable at runtime (stored on the
// base Renderable class) but only declares it on text-like options. Augment
// RenderableOptions so JSX accepts `selectable={false}` on box click-targets.
import "@opentui/core"

declare module "@opentui/core" {
  interface RenderableOptions {
    selectable?: boolean
  }
}
