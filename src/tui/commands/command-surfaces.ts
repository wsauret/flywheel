import type { KernelSurface } from "../../protocol/command-catalog-protocol-types.js"
import type { SurfaceOpening } from "../../protocol/client/surface-presentation.js"

/** What a command hands the surface it opens and, for an opening that waited
 *  on the runtime, whether the opening is still wanted. */
export interface SurfaceRequest extends SurfaceOpening {
  readonly isCurrent?: () => boolean
}

export type OpenSurface = (surface: string, request?: SurfaceRequest) => boolean | Promise<boolean>

/** The terminal's place for every kernel surface. Total by type, so a new
 *  protocol surface does not compile until the terminal maps it. A module's
 *  surfaces register with the module's terminal home instead. */
export type KernelSurfaceTable = { readonly [Surface in KernelSurface]: (request: SurfaceRequest) => void | Promise<void> }

/** Opens a kernel surface from the table or a module surface from `modules`;
 *  any other id names a surface this terminal does not have. */
export function createSurfaceRouter(deps: {
  readonly kernel: KernelSurfaceTable
  readonly modules: ReadonlyMap<string, (request: SurfaceRequest) => boolean | Promise<boolean>>
  /** Reports a kernel surface that failed to open. */
  readonly report: (task: () => Promise<void>) => void
  readonly missing: (surface: string) => void
}): OpenSurface {
  const isKernel = (surface: string): surface is KernelSurface => Object.hasOwn(deps.kernel, surface)
  return (surface, request = {}) => {
    if (isKernel(surface)) {
      deps.report(async () => { await deps.kernel[surface](request) })
      return true
    }
    const open = deps.modules.get(surface)
    if (open) return open(request)
    deps.missing(surface)
    return false
  }
}
