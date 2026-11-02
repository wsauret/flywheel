import { describe, expect, test } from "bun:test"
import { createToastPresenter } from "../../../../src/tui/utils/toast-presenter.js"

interface ShownToast {
  message: string
  variant: "info" | "warning" | "error" | "success"
  duration?: number
}

describe("toast presenter", () => {
  test("deduplicates per family on the message and forwards only display fields", () => {
    const shown: ShownToast[] = []
    const presenter = createToastPresenter((options) => { shown.push(options) })

    presenter.present("session.load_failed", { message: "boom", variant: "error", duration: 7000, dedupeKey: "s1\0boom" })
    presenter.present("session.load_failed", { message: "boom", variant: "error", duration: 7000, dedupeKey: "s1\0boom" })
    // A different family is its own dedup domain.
    presenter.present("config.invalid", { message: "boom", variant: "error" })

    expect(shown).toEqual([
      { message: "boom", variant: "error", duration: 7000 },
      { message: "boom", variant: "error" },
    ])
  })

  test("a changed key re-presents, and reset re-arms an unchanged one", () => {
    const shown: ShownToast[] = []
    const presenter = createToastPresenter((options) => { shown.push(options) })

    presenter.present("transcript.load_failed", { message: "boom", variant: "error" })
    presenter.present("transcript.load_failed", { message: "boom again", variant: "error" })
    presenter.present("transcript.load_failed", { message: "boom again", variant: "error" })
    presenter.reset("transcript.load_failed")
    presenter.present("transcript.load_failed", { message: "boom again", variant: "error" })

    expect(shown.map((toast) => toast.message)).toEqual(["boom", "boom again", "boom again"])
  })
})
