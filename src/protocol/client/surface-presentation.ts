import type { CommandSurfaceTarget } from "../command-catalog-protocol-types.js"

/** What a command hands the surface it opens: the target inside the surface
 *  and the command's argument text, such as the query of Find in transcripts. */
export interface SurfaceOpening {
  readonly target?: CommandSurfaceTarget
  readonly argument?: string
}

/** A delayed surface presentation retains the placement and opening intent that requested it. */
export type CaptureSurfaceOpener = () => (surface: string, sessionId?: string, opening?: SurfaceOpening) => void

/** Creates one presentation owner for runtime commands. Direct controls still open surfaces immediately. */
export function createSurfaceOpener(deps: {
  readonly sessionId: () => string | undefined
  readonly placement: () => number
  readonly surfaces: () => readonly unknown[]
  readonly openSurface: (surface: string, isCurrent: () => boolean, opening?: SurfaceOpening) => void
}): CaptureSurfaceOpener {
  let intent = 0
  return () => {
    const requested = ++intent
    const sessionId = deps.sessionId()
    const placement = deps.placement()
    const surfaces = deps.surfaces()
    return (surface, sourceSessionId, opening) => {
      const isCurrent = (): boolean => {
        if (requested !== intent) return false
        const current = deps.surfaces()
        if (surfaces.some((identity, index) => identity !== current[index])) return false
        return sourceSessionId === undefined || (sourceSessionId === sessionId && sessionId === deps.sessionId() && placement === deps.placement())
      }
      if (isCurrent()) deps.openSurface(surface, isCurrent, opening)
    }
  }
}
