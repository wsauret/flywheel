import jsQR from "jsqr"

import { parsePairingCodeUrl } from "../../src/protocol/modules/remote/relay-protocol.js"

/** Reads a pairing code with the camera.
 *
 *  Safari has no `BarcodeDetector`, so frames go through a bundled decoder.
 *  The scanner takes the whole screen while it runs, because a camera preview
 *  with the client behind it is two surfaces fighting for one small screen,
 *  and settles with the first frame that decodes as a pairing code, or with
 *  nothing when the person dismisses it. */

const FRAME_INTERVAL_MS = 120

export function scanPairingCode(): Promise<string | undefined> {
  const settled = Promise.withResolvers<string | undefined>()
  const overlay = document.createElement("div")
  overlay.className = "scan-overlay"
  const video = document.createElement("video")
  video.setAttribute("playsinline", "")
  video.muted = true
  const hint = document.createElement("p")
  hint.className = "scan-hint"
  hint.textContent = "Point the camera at the code Flywheel is showing."
  const cancel = document.createElement("button")
  cancel.className = "scan-cancel"
  cancel.textContent = "Cancel"
  overlay.append(video, hint, cancel)
  document.body.append(overlay)

  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d", { willReadFrequently: true })
  let stream: MediaStream | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false

  const finish = (result: string | undefined): void => {
    if (done) return
    done = true
    if (timer !== undefined) clearTimeout(timer)
    for (const track of stream?.getTracks() ?? []) track.stop()
    overlay.remove()
    settled.resolve(result)
  }
  cancel.addEventListener("click", () => finish(undefined))

  /** One frame through the decoder; the first pairing code wins. */
  const tick = (): void => {
    if (done) return
    if (video.readyState >= 2 && context) {
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      context.drawImage(video, 0, 0)
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })
      if (found) {
        try {
          parsePairingCodeUrl(found.data)
          finish(found.data)
          return
        } catch {
          hint.textContent = "That code is not a Flywheel pairing code."
        }
      }
    }
    timer = setTimeout(tick, FRAME_INTERVAL_MS)
  }

  const start = async (): Promise<void> => {
    let granted: MediaStream
    try {
      granted = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
    } catch {
      hint.textContent = "The camera is not available. Paste the link from the code instead."
      timer = setTimeout(() => finish(undefined), 2_500)
      return
    }
    if (done) {
      for (const track of granted.getTracks()) track.stop()
      return
    }
    stream = granted
    video.srcObject = granted
    try {
      await video.play()
    } catch {
      finish(undefined)
      return
    }
    tick()
  }
  void start()
  return settled.promise
}
