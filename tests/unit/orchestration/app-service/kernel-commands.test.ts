import { describe, expect, it } from "bun:test"

import { builtInCommandDeclarations, builtInCommandDescriptor } from "../../../../src/orchestration/app-service/kernel-commands.js"
import { commandMenuGroups } from "../../../../src/protocol/client/command-menu.js"
import { SHIPPED_MODULES, composeFirstPartyModules } from "../../../../src/orchestration/modules.js"

/** Each module a person can turn off, with the name its Settings row shows. */
const switchable = SHIPPED_MODULES.flatMap((module) => module.contributions.flatMap((contribution) =>
  contribution.domain === "settings" && contribution.value.control === "binary" ? [{ id: module.id, label: contribution.value.label }] : []))

/** The module and every module that needs it, which turn off with it. */
function withDependents(id: string): readonly (typeof SHIPPED_MODULES)[number]["id"][] {
  const off = new Set<string>([id])
  for (let grew = true; grew;) {
    grew = false
    for (const module of SHIPPED_MODULES) {
      if (!off.has(module.id) && module.dependencies.some((dependency) => off.has(dependency))) { off.add(module.id); grew = true }
    }
  }
  return SHIPPED_MODULES.map((module) => module.id).filter((moduleId) => off.has(moduleId))
}

describe("the published command menu", () => {
  it("lists the installed modules' and the kernel's commands in the shipped expected-use order", () => {
    const { top, chat, more } = commandMenuGroups(builtInCommandDeclarations(composeFirstPartyModules()).map(builtInCommandDescriptor))
    expect(top.map((command) => command.title)).toEqual([
      "Usage", "Model and effort", "Models", "Authentication", "Settings", "Notifications", "Background work",
      "Remote access", "MCP servers", "Status", "Auth profiles", "Doctor", "Stats", "Keyboard shortcuts",
    ])
    expect(chat.map((command) => command.title)).toEqual(["New chat", "Sessions", "Changes", "Compact conversation", "Resume", "Attach files", "Find in transcripts"])
    expect(more.map((command) => command.title)).toEqual(["Commands"])
  })

  it("names the context-window reading beside Compact conversation, which opens no surface", () => {
    const { chat } = commandMenuGroups(builtInCommandDeclarations(composeFirstPartyModules()).map(builtInCommandDescriptor))
    expect(chat.flatMap((command) => command.reading === undefined ? [] : [[command.title, command.reading]])).toEqual([["Compact conversation", "context-window"]])
  })
})

describe("built-in commands with a module turned off", () => {
  it("never name the module in the text of a command that stays", () => {
    expect(switchable.length).toBeGreaterThan(0)
    const offenders = switchable.flatMap(({ id, label }) => {
      const name = label.toLowerCase().replace(/s$/, "")
      return builtInCommandDeclarations(composeFirstPartyModules(undefined, withDependents(id)))
        .filter((command) => `${command.title} ${command.description}`.toLowerCase().includes(name))
        .map((command) => `${label} off: /${command.id} ${command.description}`)
    })
    expect(offenders).toEqual([])
  })
})
