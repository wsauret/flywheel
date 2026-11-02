/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import type { Component } from "solid-js"

const { testRender } = await import("@opentui/solid")
const { createComponent } = await import("solid-js/web")
const { createLazyTuiView } = await import("../../../../src/tui/components/lazy-tui-view.js")
const { ThemeProvider } = await import("../../../../src/tui/context/theme.js")

type LazyHarness = Component<{ body: string }>

function renderLazyView(LazyView: LazyHarness, body: string) {
  return testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(LazyView, { body })
      },
    }),
    { width: 48, height: 10 },
  )
}

async function settleLazyView(result: Awaited<ReturnType<typeof renderLazyView>>): Promise<void> {
  await result.renderOnce()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await result.renderOnce()
}

describe("createLazyTuiView", () => {
  it("forwards typed props and caches a successful import", async () => {
    let attempts = 0
    const Loaded: Component<{ body: string }> = (props) => <text>{props.body}</text>
    const LazyView = createLazyTuiView("Sessions", async () => {
      attempts += 1
      return Loaded
    })

    for (const body of ["First mount", "Second mount"]) {
      const result = await renderLazyView(LazyView, body)
      try {
        await settleLazyView(result)
        expect(result.captureCharFrame()).toContain(body)
      } finally {
        result.renderer.destroy()
      }
    }
    expect(attempts).toBe(1)
  })

  it("shows a failure state and retries a rejected import on the next mount", async () => {
    let attempts = 0
    const Loaded: Component<{ body: string }> = (props) => <text>{props.body}</text>
    const LazyView = createLazyTuiView("Sessions", () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error("module import failed")) : Promise.resolve(Loaded)
    })

    const first = await renderLazyView(LazyView, "Loaded after retry")
    try {
      await settleLazyView(first)
      expect(first.captureCharFrame()).toContain("Could not load this view.")
    } finally {
      first.renderer.destroy()
    }

    const second = await renderLazyView(LazyView, "Loaded after retry")
    try {
      await settleLazyView(second)
      expect(second.captureCharFrame()).toContain("Loaded after retry")
      expect(attempts).toBe(2)
    } finally {
      second.renderer.destroy()
    }
  })

  it("shares one pending import across concurrent mounts", async () => {
    let attempts = 0
    let resolveLoad!: (component: Component<{ body: string }>) => void
    const load = new Promise<Component<{ body: string }>>((resolve) => {
      resolveLoad = resolve
    })
    const LazyView = createLazyTuiView("Sessions", () => {
      attempts += 1
      return load
    })
    const result = await testRender(
      () => createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          return <box flexDirection="column"><LazyView body="First" /><LazyView body="Second" /></box>
        },
      }),
      { width: 48, height: 20 },
    )

    try {
      await result.renderOnce()
      resolveLoad((props) => <text>{props.body}</text>)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await result.renderOnce()
      expect(attempts).toBe(1)
      expect(result.captureCharFrame()).toContain("First")
      expect(result.captureCharFrame()).toContain("Second")
    } finally {
      result.renderer.destroy()
    }
  })

  it("settles safely after its original mount is disposed", async () => {
    let resolveLoad!: (component: Component<{ body: string }>) => void
    const load = new Promise<Component<{ body: string }>>((resolve) => {
      resolveLoad = resolve
    })
    const LazyView = createLazyTuiView("Sessions", () => load)
    const first = await renderLazyView(LazyView, "Closed")
    await first.renderOnce()
    first.renderer.destroy()
    resolveLoad((props) => <text>{props.body}</text>)
    await Promise.resolve()
    await Promise.resolve()

    const second = await renderLazyView(LazyView, "Loaded after close")
    try {
      await settleLazyView(second)
      expect(second.captureCharFrame()).toContain("Loaded after close")
    } finally {
      second.renderer.destroy()
    }
  })

  it("shows a failure state when a loaded module has no component export", async () => {
    const LazyView = createLazyTuiView<{ body: string }>("Sessions", () => Promise.resolve(undefined))
    const result = await renderLazyView(LazyView, "Missing")

    try {
      await settleLazyView(result)
      expect(result.captureCharFrame()).toContain("Could not load this view.")
    } finally {
      result.renderer.destroy()
    }
  })

  it("contains an exception from a resolved view", async () => {
    const Broken: Component<{ body: string }> = () => {
      throw new Error("stale modal contract")
    }
    const LazyView = createLazyTuiView("Sessions", async () => Broken)
    const result = await renderLazyView(LazyView, "Broken")

    try {
      await settleLazyView(result)
      expect(result.captureCharFrame()).toContain("Could not load this view.")
    } finally {
      result.renderer.destroy()
    }
  })
})