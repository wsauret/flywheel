import { spyOn } from "bun:test"

import * as container from "../../src/infra/process/container/process-container.js"
import type { BootIdentity, ProcessStart } from "../../src/infra/process/container/process-container.js"
import type { processHolders } from "../../src/infra/process/process-holder.js"

/** The kernel facts a holder answer rests on, as a case scripts them. */
export interface ScriptedKernel {
  start(pid: number): ProcessStart
  boot(): BootIdentity
}

const hostStart = container.processStart
const hostBoot = container.bootIdentity

/** This host's kernel, read through the functions production calls, before
 *  any case replaces them. */
export const hostKernel: ScriptedKernel = { start: (pid) => hostStart(pid), boot: () => hostBoot() }

let instances = 0

/** The production holder answers of a fresh process whose kernel is
 *  `kernel`. Each call loads its own copy of the holder module, so nothing it
 *  caches (its own identity, the host boot, the versions it warned about) is
 *  shared with another case or with this process's `processHolders`. Each
 *  answer reads the kernel through the process-container functions that the
 *  module calls, replaced only while that answer runs. */
export async function processHoldersOver(kernel: ScriptedKernel): Promise<typeof processHolders> {
  instances += 1
  const module: typeof import("../../src/infra/process/process-holder.js") = await import(`../../src/infra/process/process-holder.js?kernel=${instances}`)
  const fresh = module.processHolders
  const over = <T>(answer: () => T): T => {
    const start = spyOn(container, "processStart").mockImplementation((pid) => kernel.start(pid))
    const boot = spyOn(container, "bootIdentity").mockImplementation(() => kernel.boot())
    try {
      return answer()
    } finally {
      start.mockRestore()
      boot.mockRestore()
    }
  }
  return { own: () => over(() => fresh.own()), state: (holder) => over(() => fresh.state(holder)) }
}
