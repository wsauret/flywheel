import { describe, expect, it } from "bun:test"
import type { JSX } from "solid-js"
import { moduleNavigation } from "../../../src/tui/modules.js"
import type { TuiModuleClient } from "../../../src/tui/tui-module-client.js"

function client(id: string, handles: string, asked: string[]): TuiModuleClient {
  return {
    provide: (children: () => JSX.Element) => children(),
    openUri: async () => false,
    openSession: async (session) => { asked.push(id); return session.kind === handles },
    restore: async () => false,
  }
}

describe("moduleNavigation", () => {
  it("openSession resolves to the first module client that handles the target, and to false when none does", async () => {
    const asked: string[] = []
    const navigation = moduleNavigation([client("first", "workflow-agent", asked), client("second", "subagent", asked), client("third", "subagent", asked)])

    expect(await navigation.openSession({ id: "member", kind: "subagent" })).toBe(true)
    expect(asked).toEqual(["first", "second"])

    asked.length = 0
    expect(await navigation.openSession({ id: "chat", kind: "chat" })).toBe(false)
    expect(asked).toEqual(["first", "second", "third"])
  })

  it("openTarget passes over a client that opens no targets", async () => {
    const navigation = moduleNavigation([client("first", "none", []), { ...client("second", "none", []), openTarget: async (target) => target.kind === "workflow" }])

    expect(await navigation.openTarget({ kind: "workflow", workflowId: "w1" })).toBe(true)
  })
})
