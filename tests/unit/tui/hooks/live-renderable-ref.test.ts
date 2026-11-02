import { describe, expect, it } from "bun:test"
import { createLiveRenderableRef } from "../../../../src/tui/hooks/create-live-renderable-ref.js"

interface FakeRenderable {
  once(event: string, listener: () => void): FakeRenderable
  readonly registeredEvents: readonly string[]
  emit(event: "destroyed"): void
}

function fakeRenderable(): FakeRenderable {
  const listeners = new Map<string, Array<() => void>>()
  const registeredEvents: string[] = []
  const lifecycle: FakeRenderable = {
    registeredEvents,
    once(event, listener) {
      registeredEvents.push(event)
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return lifecycle
    },
    emit(event) {
      const registered = listeners.get(event) ?? []
      listeners.delete(event)
      for (const listener of registered) listener()
    },
  }
  return lifecycle
}

describe("createLiveRenderableRef", () => {
  it("clears a renderable when OpenTUI destroys it", () => {
    const ref = createLiveRenderableRef<FakeRenderable>()
    const renderable = fakeRenderable()

    ref.attach(renderable)
    renderable.emit("destroyed")

    expect(renderable.registeredEvents).toEqual(["destroyed"])

    expect(ref.current()).toBeNull()
  })

  it("keeps a replacement when an older renderable is destroyed", () => {
    const ref = createLiveRenderableRef<FakeRenderable>()
    const first = fakeRenderable()
    const replacement = fakeRenderable()

    ref.attach(first)
    ref.attach(replacement)
    first.emit("destroyed")

    expect(ref.current()).toBe(replacement)
  })
})
