/**
 * Soft-keyboard acceptance for the installed phone app in the iOS Simulator.
 *
 * It opens and closes the on-screen keyboard over a chat and judges each
 * change twice: from a per-frame trace of the page's layout, and from a
 * screen recording, which shows what the person sees. A pass means the
 * composer lands on the keyboard (or back on the bottom edge) in one step,
 * the header never moves, the page never scrolls, and nothing above the
 * composer moves more than once.
 *
 * Run by hand or by an agent; it is not part of a test suite. Before a run:
 *   1. Start this script. It serves the hosted phone page with a layout
 *      sampler at http://127.0.0.1:<port> (8790 by default).
 *   2. In an iPhone simulator, add that page to the Home Screen once and pair
 *      the installed app with a running Flywheel (`/remote`, then `p`; put
 *      the link on the device with `simctl pbcopy`, then paste it with Cmd+V).
 *   3. Any hardware key event, the paste included, leaves iOS showing only
 *      the keyboard's accessory bar on focus. Restore the soft keyboard with
 *      `simctl spawn <udid> defaults write com.apple.keyboard.preferences
 *      HardwareKeyboardLastSeen -bool false` (and the same for
 *      `AutomaticMinimizationEnabled`), then reboot the device.
 *   4. Open the installed app on a chat.
 * The script waits up to two minutes for the chat, then runs on its own.
 *
 *   bun --conditions=browser scripts/uat/phone-soft-keyboard.ts [--udid <udid>] [--port 8790] [--out <dir>] [--rebuild]
 */

import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { bottom, frameAt, keyboardShown, keyboardTop, startTraceServer, type Frame } from "./phone-trace.js"
import { connectSimulator, regionActivity, type Region } from "./simulator.js"

const { values: args } = parseArgs({
  options: {
    udid: { type: "string" },
    port: { type: "string", default: "8790" },
    out: { type: "string" },
    rebuild: { type: "boolean", default: false },
  },
})

interface Check {
  readonly scenario: string
  readonly name: string
  readonly pass: boolean
  readonly evidence: string
}

const say = (line: string): void => {
  process.stdout.write(`[soft-keyboard] ${line}\n`)
}

const out = args.out ?? join(tmpdir(), `flywheel-soft-keyboard-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`)
await mkdir(out, { recursive: true })
const trace = await startTraceServer({ port: Number(args.port), rebuild: args.rebuild })
const sim = await connectSimulator(args.udid)
const checks: Check[] = []

/** A chat is ready when the installed app shows its composer flush with the left edge and the layout has been still for a moment. */
const chatReady = (frame: Frame): boolean =>
  frame.standalone && frame.composer !== null && Math.abs(frame.composer[0]) < 1 && frame.field !== null && frame.toolbar !== null && Date.now() - frame.t > 700

async function waitForChat(): Promise<Frame> {
  say(`serving ${trace.origin}; waiting for the installed app to show a chat on ${sim.udid}`)
  const deadline = Date.now() + 120_000
  for (;;) {
    const frame = trace.latest()
    if (frame !== undefined && chatReady(frame)) return frame
    if (Date.now() > deadline) {
      const seen = frame === undefined ? "the page never reported" : `the page reports standalone=${frame.standalone}, composer=${JSON.stringify(frame.field)}`
      throw new Error(`no chat in the installed app at ${trace.origin}: ${seen}`)
    }
    await Bun.sleep(250)
  }
}

interface Transition {
  readonly before: Frame
  readonly after: Frame
  readonly window: readonly Frame[]
}

/** Runs `action` while recording the screen, then judges the change from the trace and the recording. */
async function transition(scenario: string, action: () => Promise<void>, settleMs = 1_500): Promise<Transition> {
  const slug = scenario.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
  const video = join(out, `${slug}.mp4`)
  const stop = await sim.record(video)
  let start: number
  let end: number
  try {
    await Bun.sleep(200)
    start = Date.now()
    await action()
    await Bun.sleep(settleMs)
    end = Date.now()
  } finally {
    // One host recording at a time: a leaked recorder blocks every later run.
    await stop()
  }
  await trace.settle(end)
  const frames = trace.frames()
  const before = frameAt(frames, start)
  const after = frameAt(frames, end)
  if (!before || !after) throw new Error(`${scenario}: the page reported no layout around the action`)
  const window = [before, ...frames.filter((frame) => frame.t > start && frame.t <= end)]
  await writeFile(join(out, `${slug}.trace.json`), JSON.stringify(window, null, 1))
  await sim.screenshot(join(out, `${slug}.png`))

  const add = (name: string, pass: boolean, evidence: string): void => {
    checks.push({ scenario, name, pass, evidence })
  }
  const scroll = Math.max(...window.map((frame) => Math.max(Math.abs(frame.scrollY), Math.abs(frame.viewport[0]))))
  add("The page never scrolls", scroll === 0, `largest scrollY or visualViewport.offsetTop: ${scroll}px over ${window.length} frames`)
  const tops = window.map((frame) => frame.toolbar?.[1] ?? Number.NaN)
  add("The header never moves", tops.every((top) => top === tops[0]), `header top per frame: ${[...new Set(tops)].join(", ")}px`)
  const steps = window.map((frame) => bottom(frame.composer)).filter((value, index, all) => index === 0 || value !== all[index - 1])
  add("The composer moves in one step", steps.length <= 2, `composer bottom edge: ${steps.join(" -> ")}px`)

  // The header band below the status bar, and the transcript band above the
  // composer at both ends of the change: neither holds the keyboard or caret.
  const headerBottom = bottom(before.toolbar)
  const regions: Region[] = [
    { name: "header", top: before.safeTop, bottom: headerBottom },
    { name: "transcript", top: headerBottom + 2, bottom: Math.min(before.composer?.[1] ?? 0, after.composer?.[1] ?? 0) - 2 },
  ]
  const [header, transcript] = await regionActivity(video, { width: before.root?.[2] ?? 0, height: before.screenHeight }, regions)
  const spans = (activity: typeof header): string => activity!.spans.map(([from, to]) => `${from.toFixed(2)}-${to.toFixed(2)}s`).join(", ") || "none"
  add("Video: the header stays still", header!.bursts === 0, `changes in rows ${regions[0]!.top}-${regions[0]!.bottom}: ${spans(header)}`)
  add("Video: the transcript moves at most once", transcript!.bursts <= 1, `changes in rows ${regions[1]!.top}-${regions[1]!.bottom}: ${spans(transcript)}`)
  return { before, after, window }
}

function opened(scenario: string, frame: Frame): void {
  const gap = bottom(frame.composer) - keyboardTop(frame)
  checks.push(
    { scenario, name: "The keyboard is up and the text field has focus", pass: keyboardShown(frame) && frame.focus.startsWith("textarea"), evidence: `visualViewport height ${frame.viewport[1]}px of ${bottom(frame.root)}px, focus ${frame.focus || "none"}` },
    { scenario, name: "The composer sits on the keyboard", pass: Math.abs(gap) <= 2, evidence: `composer bottom ${bottom(frame.composer)}px, keyboard top ${keyboardTop(frame)}px, inset ${frame.inset}px` },
  )
}

function closed(scenario: string, frame: Frame): void {
  const gap = bottom(frame.root) - bottom(frame.composer)
  checks.push(
    { scenario, name: "The keyboard is down and nothing holds focus", pass: !keyboardShown(frame) && !frame.focus.startsWith("textarea"), evidence: `visualViewport height ${frame.viewport[1]}px, focus ${frame.focus || "none"}` },
    { scenario, name: "The composer returns to the bottom edge", pass: Math.abs(gap) <= 1 && frame.inset === 0, evidence: `composer bottom ${bottom(frame.composer)}px, screen bottom ${bottom(frame.root)}px, inset ${frame.inset}px` },
  )
}

interface Point {
  readonly x: number
  readonly y: number
}

const centre = (box: NonNullable<Frame["field"]>): Point => ({ x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 })

/** A point in the transcript just under the header, clear of the opening card and the composer. */
const transcriptPoint = (frame: Frame): Point => ({ x: (frame.root?.[2] ?? 0) / 2, y: bottom(frame.toolbar) + 40 })

let failure: unknown
try {
  const ready = await waitForChat()
  say(`chat ready: screen ${ready.root?.[2]}x${ready.screenHeight}, composer ${JSON.stringify(ready.composer)}`)
  if (keyboardShown(ready)) await sim.tap(transcriptPoint(ready).x, transcriptPoint(ready).y)
  await Bun.sleep(800)

  const first = await transition("Focus the composer", () => sim.tap(centre(trace.latest()!.field!).x, centre(trace.latest()!.field!).y))
  opened("Focus the composer", first.after)

  const tapOut = await transition("Tap the transcript", () => sim.tap(transcriptPoint(first.after).x, transcriptPoint(first.after).y))
  closed("Tap the transcript", tapOut.after)

  const second = await transition("Focus the composer again", () => sim.tap(centre(trace.latest()!.field!).x, centre(trace.latest()!.field!).y))
  opened("Focus the composer again", second.after)

  // The accessory bar's Done key sits at its right end, just under the visual viewport.
  const done = await transition("Done on the keyboard", () => sim.tap((second.after.root?.[2] ?? 0) - 36, keyboardTop(second.after) + 26))
  closed("Done on the keyboard", done.after)
} catch (error) {
  failure = error
} finally {
  await trace.stop()
}

const failed = checks.filter((item) => !item.pass)
const lines = [
  "# Soft keyboard acceptance",
  "",
  `Simulator ${sim.udid}, page ${trace.origin}, ${new Date().toISOString()}.`,
  "",
  "| Scenario | Check | Result | Evidence |",
  "|---|---|---|---|",
  ...checks.map((item) => `| ${item.scenario} | ${item.name} | ${item.pass ? "pass" : "FAIL"} | ${item.evidence.replaceAll("|", "\\|")} |`),
  ...(failure === undefined ? [] : ["", `The run stopped early: ${failure instanceof Error ? failure.message : String(failure)}`]),
]
await writeFile(join(out, "report.md"), `${lines.join("\n")}\n`)
for (const item of checks) say(`${item.pass ? "pass" : "FAIL"}  ${item.scenario}: ${item.name} (${item.evidence})`)
if (failure !== undefined) say(`stopped early: ${failure instanceof Error ? failure.message : String(failure)}`)
say(`${checks.length - failed.length} of ${checks.length} checks passed; report, traces, screenshots, and recordings in ${out}`)
process.exit(failed.length === 0 && failure === undefined ? 0 : 1)
