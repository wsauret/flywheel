/**
 * Serves the hosted phone page on loopback with a per-frame layout sampler
 * injected, and collects what the sampler reports.
 *
 * The page is the same build `relay/app/serve.ts` serves; only the HTML gains
 * one inline script. The script reads the layout on every animation frame and
 * posts each frame that differs from the one before to `/__trace` on the same
 * origin, so the phone needs no Web Inspector and the product carries no test
 * hook. Every frame carries the wall clock, which the Simulator shares with
 * this machine, so a frame lines up with the moment the driver acted.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

/** `relay/app/build.ts` resolves the same directory; importing it eagerly would load the icon renderer on every run. */
const DIST = join(import.meta.dir, "..", "..", "relay", "app", "dist")

/** `[left, top, width, height]` in CSS pixels, or null when the element is absent or hidden. */
export type Box = readonly [number, number, number, number] | null

export interface Frame {
  /** Wall clock in milliseconds. */
  readonly t: number
  readonly innerHeight: number
  readonly screenHeight: number
  /** `[offsetTop, height]` of `visualViewport`. */
  readonly viewport: readonly [number, number]
  readonly scrollY: number
  readonly safeTop: number
  /** The `--fw-keyboard-inset` the host set on `#root`, in pixels. */
  readonly inset: number
  readonly standalone: boolean
  /** `tag.class` of the focused element, or an empty string. */
  readonly focus: string
  readonly root: Box
  readonly toolbar: Box
  readonly composer: Box
  readonly field: Box
  readonly transcript: Box
}

/** Runs in the page. It stays plain JavaScript because the page loads it as an inline script. */
const SAMPLER = String.raw`(() => {
  const pending = [];
  let last = "";
  let current = null;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);pointer-events:none;visibility:hidden";
  const box = (selector) => {
    for (const element of document.querySelectorAll(selector)) {
      if (!element.checkVisibility()) continue;
      const r = element.getBoundingClientRect();
      // The phone keeps the session list beside the chat, translated off screen.
      if (r.right <= 0 || r.left >= window.innerWidth) continue;
      return [r.left, r.top, r.width, r.height].map((value) => Math.round(value * 10) / 10);
    }
    return null;
  };
  const sample = () => {
    if (!probe.isConnected && document.body) document.body.appendChild(probe);
    const root = document.querySelector("#root");
    const active = document.activeElement;
    const viewport = window.visualViewport;
    const frame = {
      innerHeight: window.innerHeight,
      screenHeight: window.screen.height,
      viewport: viewport ? [viewport.offsetTop, Math.round(viewport.height * 10) / 10] : [0, window.innerHeight],
      scrollY: window.scrollY,
      safeTop: probe.isConnected ? probe.getBoundingClientRect().height : 0,
      inset: root ? parseFloat(root.style.getPropertyValue("--fw-keyboard-inset")) || 0 : 0,
      standalone: navigator.standalone === true,
      focus: active && active !== document.body ? active.tagName.toLowerCase() + (active.className && typeof active.className === "string" ? "." + active.className.trim().split(/\s+/).join(".") : "") : "",
      root: box("#root"),
      toolbar: box(".toolbar"),
      composer: box(".composer"),
      field: box(".composer textarea"),
      transcript: box(".transcript"),
    };
    const key = JSON.stringify(frame);
    if (key !== last) {
      last = key;
      current = { t: performance.timeOrigin + performance.now(), ...frame };
      pending.push(current);
    }
    requestAnimationFrame(sample);
  };
  // A still page records nothing new, so it repeats its newest frame: a
  // collector that started after the last change still learns the layout.
  const flush = () => {
    if (pending.length === 0 && current) pending.push(current);
    if (pending.length === 0) return;
    const body = JSON.stringify(pending.splice(0));
    fetch("/__trace", { method: "POST", body, keepalive: true }).catch(() => {});
  };
  setInterval(flush, 200);
  requestAnimationFrame(sample);
})();`

export interface TraceServer {
  readonly origin: string
  /** Every frame received since the server started, oldest first. */
  frames(): readonly Frame[]
  /** The newest frame, or undefined before the page has reported one. */
  latest(): Frame | undefined
  /** Waits until frames up to `until` (wall clock) have arrived, so a window read after it is complete. */
  settle(until: number): Promise<void>
  stop(): Promise<void>
}

/** Builds the page when no build exists (or when asked), then serves it with the sampler on `port`. */
export async function startTraceServer(options: { readonly port: number; readonly rebuild: boolean }): Promise<TraceServer> {
  if (options.rebuild || !existsSync(join(DIST, "index.html"))) {
    const { buildApp } = await import("../../relay/app/build.js")
    await buildApp({ version: "dev" })
  }
  const html = (await Bun.file(join(DIST, "index.html")).text()).replace("</head>", `<script>${SAMPLER}</script>\n</head>`)
  const frames: Frame[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/__trace" && request.method === "POST") {
        // The sampler above is the only writer and posts an array of frames.
        const posted: Frame[] = await request.json()
        for (const frame of posted) if (frame.t > (frames.at(-1)?.t ?? 0)) frames.push(frame)
        return new Response(null, { status: 204 })
      }
      const page = new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
      if (url.pathname === "/") return page
      const file = Bun.file(join(DIST, url.pathname.slice(1)))
      return await file.exists() ? new Response(file) : page
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    frames: () => frames,
    latest: () => frames.at(-1),
    async settle(until) {
      // The sampler flushes every 200 ms and a quiet page sends nothing, so
      // no frame proves completeness: wait two flushes past `until`.
      await Bun.sleep(Math.max(0, until - Date.now()) + 450)
    },
    stop: () => server.stop(true),
  }
}

/** The bottom edge of a box, or NaN when the box is absent. */
export const bottom = (box: Box): number => box ? box[1] + box[3] : Number.NaN

/** The keyboard's top edge in page coordinates. */
export const keyboardTop = (frame: Frame): number => frame.viewport[0] + frame.viewport[1]

/** Whether the visual viewport shows a soft keyboard, by the host's own threshold. */
export const keyboardShown = (frame: Frame): boolean => bottom(frame.root) - frame.viewport[1] >= 80

/** The layout as it stood at `t`: the newest frame at or before it. */
export function frameAt(frames: readonly Frame[], t: number): Frame | undefined {
  let found: Frame | undefined
  for (const frame of frames) {
    if (frame.t > t) break
    found = frame
  }
  return found
}
