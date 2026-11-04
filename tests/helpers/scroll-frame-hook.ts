import { EventEmitter } from "node:events"
import type { RenderContext, ScrollBoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

/** Runs the frame hooks of a scrollbox whose layout hooks are patched, in
 *  frame order: the box's own update hook when one is patched, then the
 *  update hook of the node that patchScrollBoxLayoutHooks keeps as the
 *  scrollbox's last child. */
export function scrollFrameHook(scrollbox: ScrollBoxRenderable): (deltaTime: number) => void {
  const host = scrollbox.getChildren().at(-1)
  // oxlint-disable-next-line anti-slop/no-reflect-get -- boundary: the OpenTUI update hook is protected but is the controller's actual installed callback.
  const update: unknown = host && Object.hasOwn(host, "onUpdate") ? Reflect.get(host, "onUpdate") : undefined
  if (typeof update !== "function") throw new Error("scrollbox frame hook was not patched")
  // oxlint-disable-next-line anti-slop/no-reflect-get -- boundary: the OpenTUI update hook is protected but is the controller's actual installed callback.
  const start: unknown = Object.hasOwn(scrollbox, "onUpdate") ? Reflect.get(scrollbox, "onUpdate") : undefined
  return (deltaTime) => {
    if (typeof start === "function") start.call(scrollbox, deltaTime)
    update.call(host, deltaTime)
  }
}

// The frame hook is a real renderable, so fake scrollboxes lend it the context
// of one small test renderer. Test files share this module in one process, so
// the renderer lives as long as the process and never renders: each fake
// context drops render requests. A frame hook node requests a render when it
// is added or destroyed, and a frame of this renderer would run beside the
// renderer of a later test file and fail its native frame step (OutputBusy).
const { renderer } = await createTestRenderer({ width: 10, height: 10 })

/** A scrollbox part, the viewport or the content, whose size changes reach
 *  the resize listeners that patchScrollBoxLayoutHooks adds. */
export type FakeScrollPart<Fields extends object> = Fields & EventEmitter

export function fakeScrollPart<Fields extends object>(fields: Fields): FakeScrollPart<Fields> {
  return Object.assign(new EventEmitter(), fields)
}

export interface FakeFrameHookHost {
  readonly ctx: RenderContext
  /** Holds the frame hook node that patchScrollBoxLayoutHooks appends. */
  add(node: object): number
  refreshHooks(): void
  readonly viewport: FakeScrollPart<object>
  readonly content: FakeScrollPart<object>
  /** Runs the update hook of the appended frame hook node, when there is one. */
  runFrame(deltaTime: number, beforeUpdate?: () => void): void
}

/** The part of a scrollbox that patchScrollBoxLayoutHooks needs, for fakes. */
export function fakeFrameHookHost(): FakeFrameHookHost {
  let frameHook: object | undefined
  const ctx: RenderContext = Object.create(renderer.root.ctx)
  Object.defineProperty(ctx, "frameId", { value: 0, writable: true })
  Object.defineProperty(ctx, "requestRender", { value: () => {} })
  return {
    ctx,
    add(node) {
      frameHook = node
      return 0
    },
    refreshHooks() {},
    viewport: fakeScrollPart({}),
    content: fakeScrollPart({}),
    runFrame(deltaTime, beforeUpdate) {
      ctx.frameId += 1
      beforeUpdate?.()
      // oxlint-disable-next-line anti-slop/no-reflect-get -- boundary: the OpenTUI update hook is protected but is the controller's actual installed callback.
      const update: unknown = frameHook && Reflect.get(frameHook, "onUpdate")
      if (typeof update === "function") update.call(frameHook, deltaTime)
    },
  }
}
