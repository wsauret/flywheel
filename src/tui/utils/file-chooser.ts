import type { OwnedCommandRunner } from "../../infra/owned-command.js"

/** A person browsing for a file takes their time; a dialog nobody closes is
 *  ended here so its container never outlives the session that opened it. */
const CHOOSER_LEASE_MS = 10 * 60_000

export type FileChoice =
  | { readonly kind: "chosen"; readonly paths: readonly string[] }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable"; readonly reason: string }

/** The command that opens this computer's own file chooser and prints one
 *  picked path per line, or nothing when the platform has no chooser to ask.
 *  macOS asks the system through osascript, Windows through the .NET
 *  open-file dialog, Linux through zenity or kdialog, whichever is installed. */
export function fileChooserCommand(platform: NodeJS.Platform, which: (tool: string) => string | null, title: string): readonly string[] | undefined {
  if (platform === "darwin" && which("osascript")) {
    const prompt = title.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
    return [
      "osascript",
      "-e", `set chosen to choose file with prompt "${prompt}" with multiple selections allowed`,
      "-e", "set out to \"\"",
      "-e", "repeat with f in chosen",
      "-e", "set out to out & POSIX path of f & linefeed",
      "-e", "end repeat",
      "-e", "return out",
    ]
  }
  if (platform === "win32") {
    const prompt = title.replace(/'/g, "''")
    // -STA because the dialog is a Windows Forms window, which needs a
    // single-threaded apartment; the console stays hidden, the dialog does not.
    return [
      "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect = $true; $d.Title = '${prompt}'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) } }`,
    ]
  }
  if (platform === "linux") {
    if (which("zenity")) return ["zenity", "--file-selection", "--multiple", "--separator=\n", `--title=${title}`]
    if (which("kdialog")) return ["kdialog", "--getopenfilename", ".", "--multiple", "--separate-output", "--title", title]
  }
  return undefined
}

/** Opens the chooser and answers what was picked. The chooser is its own
 *  window, so the terminal keeps drawing while it is up. Every chooser exits
 *  without output when the person cancels, and macOS and Linux exit nonzero
 *  as well; both read as a cancel, never as a failure. */
export async function chooseFiles(
  run: OwnedCommandRunner,
  title: string,
  platform: NodeJS.Platform = process.platform,
  which: (tool: string) => string | null = (tool) => Bun.which(tool),
): Promise<FileChoice> {
  const command = fileChooserCommand(platform, which, title)
  if (command === undefined) {
    const hint = platform === "linux" ? "Install zenity or kdialog, or paste an image with ctrl+v." : "Paste an image with ctrl+v instead."
    return { kind: "unavailable", reason: `This computer has no file chooser Flywheel can open. ${hint}` }
  }
  const result = await run(command, { timeoutMs: CHOOSER_LEASE_MS })
  if (result.timedOut) return { kind: "unavailable", reason: "The file chooser was open for ten minutes without a pick and was closed." }
  const paths = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  return paths.length === 0 ? { kind: "cancelled" } : { kind: "chosen", paths }
}
