import type { ProcessorClaims } from "../../src/orchestration/agent-runtime/tools/processor-claims.js"

let instances = 0

/** The processor claims of a fresh project executor process. Production
 *  builds one registry per process through `sharedProcessorClaims`, so each
 *  call loads its own copy of the module, and no claim, hold, or listener is
 *  shared with another case or with this process's own registry. */
export async function freshProcessorClaims(): Promise<ProcessorClaims> {
  instances += 1
  const module: typeof import("../../src/orchestration/agent-runtime/tools/processor-claims.js") = await import(`../../src/orchestration/agent-runtime/tools/processor-claims.js?executor=${instances}`)
  return module.sharedProcessorClaims()
}
