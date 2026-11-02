import { createRoot, createSignal } from "solid-js"

import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { createBlockDisclosure } from "./block-disclosure.js"
import { Block } from "./blocks.js"
import { presentedBlock } from "../client/presented-block-fixture.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import type { MutationEvidenceReader } from "../../../src/protocol/client/mutation-evidence.js"

type HostNode = ReturnType<typeof createElement>

function withoutRowMeta(node: HostNode): HostNode {
  return { ...node, children: node.children.filter(child => child.properties.class !== "row-meta").map(withoutRowMeta) }
}

/** Mounts one tool row in the in-memory host with an entry the test repaves,
 *  the way a background command's row changes when it settles. */
export function mountToolRow(entry: FrontendToolEntry, evidenceReader?: MutationEvidenceReader) {
  const root = createElement("root")
  const disclosure = createBlockDisclosure()
  const [block, setBlock] = createSignal(entry)
  const openedPaths: string[] = []
  let hydrationRequests = 0
  const dispose = createRoot((disposeRoot) => {
    insert(root, () => (
      <Block
        block={presentedBlock(block())}
        sessionId="session-1"
        disclosure={disclosure}
        mutationEvidence={evidenceReader}
        canOpenFiles={true}
        onOpenFile={path => { openedPaths.push(path) }}
        onHydrate={() => { hydrationRequests += 1 }}
        onTerminateBackground={() => {}}
        onDetachBash={() => {}}
        working={() => false}
        onHydrateGroup={() => {}}
        onSelectSession={() => {}}
        roleAssignments={{ get: () => undefined, subscribe: (_sessionId, listener) => { listener(undefined); return () => {} } }}
        statuses={{ get: () => undefined, subscribe: () => () => {} }}
        writeSyntaxTheme="vesper"
      />
    ))
    return disposeRoot
  })
  return {
    open: () => disclosure.setOpen("session-1", `tool:${entry.id}`, true),
    close: () => disclosure.setOpen("session-1", `tool:${entry.id}`, false),
    settle: (next: FrontendToolEntry) => setBlock(next),
    /** The row's own text, without its time corner, which these tests do not assert. */
    text: () => textContent(withoutRowMeta(root)),
    openedPaths,
    hydrationRequests: () => hydrationRequests,
    click: (label: string) => {
      const button = nodes(root).find(node => node.tag === "button" && textContent(node) === label)
      if (!button || typeof button.properties.onClick !== "function") throw new Error(`Button not found: ${label}`)
      button.properties.onClick()
    },
    files: () => nodes(root).filter((node) => node.tag === "section" && String(node.properties.class).includes("diff-file")).map((node) => ({
      classList: node.properties.classList,
      style: node.properties.style,
      html: nodes(node).map((child) => child.properties.innerHTML ?? "").join(""),
    })),
    dispose,
  }
}
