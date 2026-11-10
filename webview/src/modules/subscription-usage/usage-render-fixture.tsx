import { createComponent } from "solid-js"

import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import type { UsageAccountsResult, UsageMutationResult, UsageSpendResult } from "../../../../src/protocol/modules/subscription-usage.js"
import { fakeLanes } from "../../../../tests/helpers/fake-lanes.js"
import { mountClientSheet } from "../../app/budget-render-fixture.js"
import { nodes, textContent } from "../../app/render-ownership-host-fixture.js"
import { UsageSheet } from "./sheet.js"

/** A read lost with its lane, built from the sheet's own copy of the class, which the build bundles with it. */
export function laneLost(): Error {
  return new RuntimeLaneLost(new Error("lane closed"))
}

/** The runtime's answer to a provider check that it ran. */
export const checked: UsageMutationResult = { ok: true, usage: { profileId: "profile", authorityIncarnation: "authority", revision: 4, generation: 2, asOf: 0 } }

/** What the fake runtime answers each usage call with. A check is `usage.open` or `usage.refresh`; each answer can
 *  hold, reject, or refuse. */
export interface UsageAnswers {
  readonly accounts: () => Promise<UsageAccountsResult>
  readonly spend?: () => Promise<UsageSpendResult>
  readonly check?: (type: "usage.open" | "usage.refresh") => Promise<UsageMutationResult>
}

/** Mounts the production Usage sheet over `answers`, on lanes the test opens. */
export function mountUsageSheet(answers: UsageAnswers) {
  const lanes = fakeLanes()
  const check = answers.check ?? (async () => checked)
  const unscripted = async (): Promise<never> => { throw new Error("No scripted spend reading") }
  const mounted = mountClientSheet(() => createComponent(UsageSheet, {}), {
    queries: { "usage.accounts": () => answers.accounts(), "usage.spend": () => (answers.spend ?? unscripted)() },
    mutations: { "usage.open": () => check("usage.open"), "usage.refresh": () => check("usage.refresh") },
  }, lanes.client)
  const options = (label: string) => {
    const segment = mounted.elements().find((node) => node.properties.role === "radiogroup" && node.properties["aria-label"] === label)
    return segment === undefined ? [] : nodes(segment).filter((node) => node.tag === "button")
  }
  return {
    ...mounted,
    refresh: () => mounted.clickButton(["Refresh"]),
    /** Opens a new lane, as the connection does once it is back. */
    openLane: () => lanes.open(),
    /** Chooses `option` on the segment labelled `label`. */
    choose(label: string, option: string) {
      const button = options(label).find((node) => textContent(node) === option)
      const click = button?.properties.onClick
      if (typeof click !== "function") throw new Error(`No ${option} option on ${label}`)
      click()
    },
    /** The option that the segment labelled `label` marks as chosen. */
    chosen: (label: string) => {
      const button = options(label).find((node) => node.properties["aria-checked"] === true)
      return button === undefined ? undefined : textContent(button)
    },
    /** The line beside the view switch, and whether it reads as a warning. */
    status: () => {
      const node = mounted.elements().find((candidate) => candidate.properties.class === "usage-status")
      const classList = node?.properties.classList
      return { text: node === undefined ? undefined : textContent(node), warn: typeof classList === "object" && classList !== null && "warn" in classList && classList.warn === true }
    },
  }
}
