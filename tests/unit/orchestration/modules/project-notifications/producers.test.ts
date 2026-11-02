import { describe, expect, it } from "bun:test"

import { presentationChannel } from "../../../../../src/infra/error-presentation.js"

describe("project notification producers", () => {
  it("keeps durable provider conditions off the removed pinned notice channel", () => {
    expect(presentationChannel("provider.status_alert")).toBe("status")
    expect(presentationChannel("provider.copilot_sign_in")).toBe("status")
    expect(presentationChannel("provider.chatgpt_sign_in")).toBe("status")
  })

  it("keeps non-durable emergencies and operational failures out of notification history", () => {
    expect(presentationChannel("runtime.fact_persistence_drop")).toBe("toast")
    expect(presentationChannel("transcript.unavailable")).toBe("toast")
  })

})
