
import { join } from "node:path"
import { tmpdir } from "node:os"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { OwnedCommandRunner } from "../../infra/owned-command.js"
import { windowsClipboard } from "../../infra/windows-clipboard.js"

const log = Log.create({ service: "clipboard" })

/** Long enough for a clipboard tool that waits on a display server, short
 *  enough that a wedged one never holds the render thread's promise. */
const CLIPBOARD_LEASE_MS = 5_000

async function deleteClipboardTempFile(path: string, source: string): Promise<void> {
  try {
    await Bun.file(path).delete()
  } catch (err) {
    log.debug("clipboard temp file delete failed", { path, source, error: errorMessage(err), errorDetail: errorDetail(err) })
  }
}

/** One copy shape for every platform tool: run it in an owned container with
 *  the text on its standard input, and await the exit. */
function pipeCopy(run: OwnedCommandRunner, argv: readonly string[]): (text: string) => Promise<void> {
  return async (text) => {
    const result = await run(argv, { stdin: text, timeoutMs: CLIPBOARD_LEASE_MS })
    if (result.exitCode !== 0) {
      log.info("clipboard command failed", { command: argv[0], exitCode: result.exitCode, timedOut: result.timedOut })
    }
  }
}

function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const passthrough = process.env.TMUX || process.env.STY
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
  process.stdout.write(sequence)
}


interface ClipboardImage {
  readonly mediaType: string
  readonly data: string
}

export interface Clipboard {
  copy(text: string): Promise<void>
  readImage(): Promise<ClipboardImage | null>
}

/** The platform's clipboard tools, resolved once per instance. The platform and
 *  its tools are fixed for the process, so the resolution is memoized; the owned
 *  command runner is injected, because the clipboard holds no launch authority
 *  of its own. */
export function createClipboard(run: OwnedCommandRunner): Clipboard {
  let copyMethod: ((text: string) => Promise<void>) | undefined
  let imageReadMethod: (() => Promise<ClipboardImage | null>) | undefined

  const resolveCopyMethod = (): ((text: string) => Promise<void>) => {
    const os = process.platform

    if (os === "darwin" && Bun.which("pbcopy")) return pipeCopy(run, ["pbcopy"])

    if (os === "linux") {
      if (process.env.WAYLAND_DISPLAY && Bun.which("wl-copy")) return pipeCopy(run, ["wl-copy"])
      if (Bun.which("xclip")) return pipeCopy(run, ["xclip", "-selection", "clipboard"])
      if (Bun.which("xsel")) return pipeCopy(run, ["xsel", "--clipboard", "--input"])
    }

    // Windows has no clipboard command, so the only other way to reach it is
    // PowerShell, and that costs most of a second and a whole owned process for
    // a write the platform exposes directly.
    if (os === "win32") {
      const clipboard = windowsClipboard()
      if (clipboard) {
        return async (text) => {
          if (!await clipboard.writeText(text)) log.info("clipboard was held by another process for too long to take")
        }
      }
    }

    return async (_text: string) => {}
  }

  const resolveImageReadMethod = (): (() => Promise<ClipboardImage | null>) => {
    if (process.platform === "darwin" && Bun.which("osascript")) return readMacClipboardImage
    if (process.platform === "linux" && (Bun.which("xclip") || Bun.which("wl-paste"))) return readLinuxClipboardImage
    if (process.platform === "win32" && windowsPowerShellCommand()) return readWindowsClipboardImage
    return async () => null
  }

  const readMacClipboardImage = async (): Promise<ClipboardImage | null> => {
    const formats = [
      { clipboardClass: "PNGf", ext: "png", mediaType: "image/png" },
      { clipboardClass: "JPEG", ext: "jpg", mediaType: "image/jpeg" },
      { clipboardClass: "TIFF", ext: "tiff", mediaType: "image/tiff" },
    ] as const

    for (const format of formats) {
      const path = join(tmpdir(), `flywheel-clipboard-${crypto.randomUUID()}.${format.ext}`)
      try {
        const result = await run(["osascript", "-e", clipboardImageScript(path, format.clipboardClass)], { timeoutMs: CLIPBOARD_LEASE_MS })
        if (result.exitCode !== 0) continue
        const file = Bun.file(path)
        if (!await file.exists()) continue
        const bytes = Buffer.from(await file.arrayBuffer())
        if (bytes.length === 0) continue
        if (format.mediaType !== "image/tiff") return { mediaType: format.mediaType, data: bytes.toString("base64") }

        const sharp = (await import("sharp")).default
        const png = await sharp(bytes).png().toBuffer()
        return { mediaType: "image/png", data: png.toString("base64") }
      } finally {
        await deleteClipboardTempFile(path, "mac")
      }
    }
    return null
  }

  const readLinuxClipboardImage = async (): Promise<ClipboardImage | null> => {
    const commands: Array<{ command: string[]; mediaType: string }> = []
    const mimeTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp"]
    if (Bun.which("xclip")) {
      for (const mediaType of mimeTypes) commands.push({ command: ["xclip", "-selection", "clipboard", "-t", mediaType, "-o"], mediaType })
    }
    if (Bun.which("wl-paste")) {
      for (const mediaType of mimeTypes) commands.push({ command: ["wl-paste", "--type", mediaType], mediaType })
    }

    for (const { command, mediaType } of commands) {
      // The image arrives on standard output, so the raw bytes are read rather
      // than the text view of them.
      const result = await run(command, { timeoutMs: CLIPBOARD_LEASE_MS })
      if (result.exitCode !== 0 || result.stdoutBytes.length === 0) continue
      const bytes = Buffer.from(result.stdoutBytes)
      if (mediaType !== "image/bmp") return { mediaType: mediaType === "image/jpg" ? "image/jpeg" : mediaType, data: bytes.toString("base64") }

      const sharp = (await import("sharp")).default
      const png = await sharp(bytes).png().toBuffer()
      return { mediaType: "image/png", data: png.toString("base64") }
    }
    return null
  }

  const windowsPowerShellCommand = (): string | null => {
    if (Bun.which("powershell.exe")) return "powershell.exe"
    if (Bun.which("powershell")) return "powershell"
    return null
  }

  const powerShellString = (value: string): string => {
    return `'${value.replace(/'/g, "''")}'`
  }

  const readWindowsClipboardImage = async (): Promise<ClipboardImage | null> => {
    const command = windowsPowerShellCommand()
    if (!command) return null
    const path = join(tmpdir(), `flywheel-clipboard-${crypto.randomUUID()}.png`)
    try {
      const script = [
        "Add-Type -AssemblyName System.Drawing",
        "$img = Get-Clipboard -Format Image",
        "if ($null -eq $img) { exit 1 }",
        `$img.Save(${powerShellString(path)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      ].join("; ")
      const result = await run([command, "-NonInteractive", "-NoProfile", "-Command", script], { timeoutMs: CLIPBOARD_LEASE_MS })
      if (result.exitCode !== 0) return null
      const file = Bun.file(path)
      if (!await file.exists()) return null
      const bytes = Buffer.from(await file.arrayBuffer())
      return bytes.length > 0 ? { mediaType: "image/png", data: bytes.toString("base64") } : null
    } finally {
      await deleteClipboardTempFile(path, "windows")
    }
  }

  const clipboardImageScript = (path: string, clipboardClass: string): string => {
    const escapedPath = path.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
    return [
      `set imageData to the clipboard as «class ${clipboardClass}»`,
      `set outFile to open for access POSIX file "${escapedPath}" with write permission`,
      "set eof of outFile to 0",
      "write imageData to outFile",
      "close access outFile",
    ].join("\n")
  }

  return {
    async copy(text: string): Promise<void> {
      writeOsc52(text)
      copyMethod ??= resolveCopyMethod()
      await copyMethod(text)
    },
    async readImage(): Promise<ClipboardImage | null> {
      imageReadMethod ??= resolveImageReadMethod()
      return imageReadMethod()
    },
  }
}
