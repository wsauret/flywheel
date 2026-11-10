/**
 * Drives one booted iOS Simulator for phone acceptance scripts: touches
 * through the AXe binary the pinned XcodeBuildMCP package bundles (the same
 * binary the development module's point tap uses), and screenshots and
 * screen recordings through `simctl`.
 *
 * Touches only. Typing through AXe sends hardware key events, after which iOS
 * treats a hardware keyboard as connected and shows only the keyboard's
 * accessory bar on focus, which is not the keyboard a phone user sees.
 */

import { join } from "node:path"

const AXE = join(import.meta.dir, "..", "..", "node_modules", "xcodebuildmcp", "bundled", "axe")

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`${command.slice(0, 3).join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`)
  return stdout
}

export interface Simulator {
  readonly udid: string
  tap(x: number, y: number): Promise<void>
  screenshot(path: string): Promise<void>
  /** Starts a screen recording; the returned function stops it and resolves once the file is complete. */
  record(path: string): Promise<() => Promise<void>>
}

/** The named device, or the first booted iPhone when none is named. */
export async function connectSimulator(udid?: string): Promise<Simulator> {
  // `simctl list --json` states this shape.
  const listing: { devices: { [runtime: string]: { udid: string; name: string }[] } } = JSON.parse(await run(["xcrun", "simctl", "list", "devices", "booted", "--json"]))
  const booted = Object.values(listing.devices).flat()
  const device = udid === undefined ? booted.find((item) => item.name.startsWith("iPhone")) : booted.find((item) => item.udid === udid)
  if (!device) throw new Error(udid === undefined ? "no booted iPhone simulator" : `simulator ${udid} is not booted`)
  const id = device.udid
  return {
    udid: id,
    async tap(x, y) {
      // A plain AXe tap reports success but reaches no installed web app on
      // iOS 27; a touch with an explicit down and up does.
      await run([AXE, "touch", "-x", x.toFixed(1), "-y", y.toFixed(1), "--down", "--up", "--delay", "0.15", "--udid", id])
    },
    async screenshot(path) {
      await run(["xcrun", "simctl", "io", id, "screenshot", "--type=png", path])
    },
    async record(path) {
      const child = Bun.spawn(["xcrun", "simctl", "io", id, "recordVideo", "--codec=h264", "--force", path], { stdout: "ignore", stderr: "pipe", windowsHide: true })
      // simctl states on stderr when the first frame is captured.
      const reader = child.stderr.getReader()
      let said = ""
      const deadline = Date.now() + 10_000
      while (!said.includes("Recording started")) {
        if (Date.now() > deadline) {
          child.kill()
          throw new Error(`simctl recordVideo did not start: ${said.trim()}`)
        }
        const { value, done } = await reader.read()
        if (done) throw new Error(`simctl recordVideo exited: ${said.trim()}`)
        said += new TextDecoder().decode(value)
      }
      reader.releaseLock()
      return async () => {
        child.kill("SIGINT")
        await child.exited
      }
    },
  }
}

/** A band of screen rows, in points, to watch for change. */
export interface Region {
  readonly name: string
  readonly top: number
  readonly bottom: number
}

export interface RegionActivity {
  readonly name: string
  /** Separate runs of change: frames that differ from the frame before, split by at least 100 ms of stillness. */
  readonly bursts: number
  /** Start and end of each burst, in seconds from the start of the recording. */
  readonly spans: readonly (readonly [number, number])[]
}

const FPS = 60
/** A pixel counts as changed past this luminance step; encoder noise stays below it. */
const PIXEL_STEP = 24
/** A frame counts as changed when more pixels than this changed in the region. */
const FRAME_PIXELS = 60

/**
 * Counts the separate runs of visible change in each region of a recording.
 * The frames are resampled to the screen's size in points at 60 frames a
 * second, so a region is stated in the same units as the page's layout.
 */
export async function regionActivity(path: string, screen: { readonly width: number; readonly height: number }, regions: readonly Region[]): Promise<RegionActivity[]> {
  const width = Math.round(screen.width)
  const height = Math.round(screen.height)
  const child = Bun.spawn(["ffmpeg", "-loglevel", "error", "-i", path, "-vf", `fps=${FPS},scale=${width}:${height},format=gray`, "-f", "rawvideo", "pipe:1"], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [bytes, stderr, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`ffmpeg failed (${exitCode}): ${stderr.trim()}`)
  const size = width * height
  const pixels = new Uint8Array(bytes)
  const frames = Math.floor(pixels.length / size)
  return regions.map((region) => {
    const top = Math.max(0, Math.floor(region.top))
    const end = Math.min(height, Math.ceil(region.bottom))
    const changed: number[] = []
    for (let frame = 1; frame < frames; frame++) {
      let count = 0
      for (let offset = top * width; offset < end * width; offset++) {
        if (Math.abs(pixels[frame * size + offset]! - pixels[(frame - 1) * size + offset]!) > PIXEL_STEP) count++
      }
      if (count > FRAME_PIXELS) changed.push(frame)
    }
    const spans: [number, number][] = []
    for (const frame of changed) {
      const last = spans.at(-1)
      if (last && frame / FPS - last[1] <= 0.1) last[1] = frame / FPS
      else spans.push([frame / FPS, frame / FPS])
    }
    return { name: region.name, bursts: spans.length, spans }
  })
}
