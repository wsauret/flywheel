import { RenderableEvents } from "@opentui/core"

interface DestroyableRenderable {
  once(event: RenderableEvents.DESTROYED, listener: () => void): DestroyableRenderable
}

export function createLiveRenderableRef<T extends DestroyableRenderable>() {
  let current: T | null = null

  return {
    current: (): T | null => current,
    attach(next: T): void {
      current = next
      next.once(RenderableEvents.DESTROYED, () => {
        if (current === next) current = null
      })
    },
  }
}
