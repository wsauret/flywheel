import { createComponent, createRoot, createSignal } from "solid-js"

import type { FrontendQuestionBlock } from "../client/question-answer.js"
import { createQuestionInteractions, QuestionPanel } from "./question-panel.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import { actionOwner } from "./action-owner-fixture.js"
import { fakeClient, fakeClientActions } from "./client-context-fixture.js"

type MemoryNode = ReturnType<typeof createElement>

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/** Mounts the real question panel over one question block, with a client that
 *  records each answer it sends. */
export function mountQuestionPanel(questions: FrontendQuestionBlock["questions"]) {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const [block] = createSignal<FrontendQuestionBlock>({ kind: "question", toolUseId: "question", timestamp: 1, questions })
    const [expand, setExpand] = createSignal<number>()
    const answers: unknown[] = []
    const client = fakeClient({ actions: fakeClientActions({ ...actionOwner(), answer(_toolUseId, sent) { answers.push(sent) }, cancelQuestion() {} }) })
    Reflect.set(globalThis, "__flywheelQuestionPanelTestClient", client)
    insert(root, createComponent(QuestionPanel, { block, expand, interactions: createQuestionInteractions(), sessionId: () => "chat" }))
    const row = (label: string) => {
      const found = nodes(root).find((node) => node.properties.class === "question-choice-row" && textContent(node).startsWith(label))
      if (!found) throw new Error(`No ${label} choice`)
      return found
    }
    const field = (label: string) => {
      const found = nodes(root).find((node) => typeof node.properties["aria-label"] === "string" && node.properties["aria-label"].startsWith(`${label}: `))
      if (!found) throw new Error(`No ${label} field`)
      return found
    }
    const press = (node: MemoryNode) => {
      const handler = node.properties.onClick
      if (typeof handler !== "function") throw new Error("The control has no click handler")
      handler()
    }
    return {
      dispose() { disposeRoot(); Reflect.deleteProperty(globalThis, "__flywheelQuestionPanelTestClient") },
      answers,
      settle,
      attend: () => setExpand((previous) => (previous ?? 0) + 1),
      pick: (label: string) => press(row(label)),
      checked: (label: string) => row(label).properties["aria-checked"] === true,
      field,
      type(label: string, value: string) {
        const target = field(label)
        const handler = target.properties.onInput
        if (typeof handler !== "function") throw new Error(`The ${label} field takes no input`)
        handler({ currentTarget: Object.assign(target, { value }) })
      },
      minimize() {
        const control = nodes(root).find((node) => node.properties["aria-label"] === "Minimize question")
        if (!control) throw new Error("No minimize control")
        press(control)
      },
      collapsedStrip: () => {
        const strip = nodes(root).find((node) => node.properties.class === "question-collapsed")
        return strip ? textContent(strip) : undefined
      },
    }
  })
}
