import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import pin from "../../../scripts/antigravity-engine-pin.json" with { type: "json" }
import { buildPlatformArch } from "../native-assets.js"

// The pin of the bundled Antigravity CLI (`agy`): which version and which bytes Flywheel accepts. The engine that runs
// `agy` and the source snapshot that pins it both read it, so it sits below both.

/** The one `agy` version that passed Flywheel's qualification: the version that
 *  `scripts/antigravity-engine-pin.json` pins and every build ships. */
export const QUALIFIED_ANTIGRAVITY_VERSION: string = pin.version

/** The bytes of one platform's pinned `agy`. */
export interface AntigravityPinnedBytes {
  readonly size: number
  readonly sha256: string
}

const PINNED_TARGETS: { readonly [platformArch: string]: AntigravityPinnedBytes | undefined } = pin.targets

/** The bytes that the pin states for the `agy` of `platformArch`, or nothing for a platform that the pin has no
 *  `agy` for. */
export function pinnedAntigravityBytes(platformArch: string = buildPlatformArch()): AntigravityPinnedBytes | undefined {
  return PINNED_TARGETS[platformArch]
}

/** Whether the file at `path` holds exactly the bytes `pinned`: its size first, then its SHA-256. False also when
 *  there is no such file. The hash reads the whole file off the thread, about 100 ms for the 230 MB of `agy`. */
export async function holdsPinnedAntigravityBytes(path: string, pinned: AntigravityPinnedBytes): Promise<boolean> {
  try {
    if ((await stat(path)).size !== pinned.size) return false
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest("hex") === pinned.sha256
  } catch {
    return false
  }
}
