import { createEffect, createMemo, createSignal, lazy, on, onCleanup } from "solid-js"

import { REMOTE_SURFACE } from "../../../../src/protocol/modules/remote.js"
import { needsRuntime, selectedMachine, selectionServed } from "../../../../src/protocol/modules/remote/machine-picker.js"
import type { RemoteSelection } from "../../../../src/protocol/modules/remote/relay-device.js"
import type { WebHostPresence, WebModule } from "../../web-module.js"
import type { PlacementLabels } from "../../app/screen-stack.js"
import { useClient } from "../../app/client-context.js"
import { MACHINES_SURFACE, remoteMenu } from "./menu.js"
import { RuntimesSheet, RuntimesStage } from "./runtimes.js"
import { PushGuide } from "./push-guide.js"

const RemoteSheet = lazy(() => import("./sheet.js").then((module) => ({ default: module.RemoteSheet })))

export const remoteWeb: WebModule = {
  id: "remote",
  notice: PushGuide,
  hostPresence(host, enabled) {
    const remote = host.capabilities.remote
    if (!remote) return undefined
    const [snapshot, setSnapshot] = createSignal(remote.snapshot())
    createEffect(on(enabled, (active) => {
      if (!active) return
      setSnapshot(remote.snapshot())
      onCleanup(remote.onChange(setSnapshot))
    }))
    const placement = createMemo<{ readonly selected: RemoteSelection; readonly labels: PlacementLabels } | undefined>((previous) => {
      const current = snapshot()
      const selected = current.selected
      if (!selected) return undefined
      const machine = current.runtimes.find((candidate) => candidate.runtimeId === selected.runtimeId)
      const project = machine?.placements.find((candidate) => candidate.id === selected.placementId)
      if (machine && project) return { selected, labels: { project: project.projectLabel, machine: machine.label, action: { kind: "surface", id: MACHINES_SURFACE } } }
      // Presence omits placements while offline. Only selection changes their identity.
      return previous?.selected.runtimeId === selected.runtimeId && previous.selected.placementId === selected.placementId ? previous : undefined
    })
    const Stage = () => <RuntimesStage remote={remote} />
    return {
      stage: () => needsRuntime(snapshot()) ? Stage : undefined,
      navigation: "stack",
      placement: () => placement()?.labels,
      reach: () => selectedMachine(snapshot()),
      served: () => selectionServed(snapshot()),
    } satisfies WebHostPresence
  },
  surfaces: [
    { id: REMOTE_SURFACE, sheet: RemoteSheet },
    { id: MACHINES_SURFACE, sheet: () => {
      const remote = useClient().host.capabilities.remote
      return remote ? <RuntimesSheet remote={remote} /> : null
    } },
  ],
  menu: { rows: remoteMenu },
}
