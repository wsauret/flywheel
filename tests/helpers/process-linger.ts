import { join } from "node:path"

/** What a run in a fresh Bun process returned, and how long that process
 *  stayed alive after it returned. */
export interface LingerReport {
  readonly answer: unknown
  readonly lingerMs: number
}

/** The absolute path of a module under `src/`, for an import in `setup`. */
export function sourceModule(path: string): string {
  return join(import.meta.dir, "../../src", path)
}

/** Runs `setup`, then awaits `run`, in a fresh Bun process, and answers what
 *  `run` returned and how long that process stayed alive after it returned.
 *  Nothing else in that process is pending, so any time past the answer is a
 *  handle the run left open, such as an uncancelled budget timer. A process
 *  that ends by returning, such as a CLI command, a project executor, or the
 *  account service, waits for exactly that.
 *
 *  `setup` is module source that imports what `run` needs, by absolute path,
 *  and prepares it. `run` is one expression. Neither writes to stdout, which
 *  carries the report. */
export async function lingerAfter(setup: string, run: string): Promise<LingerReport> {
  const source = [
    `import { writeSync } from "node:fs"`,
    setup,
    `const answer = await ${run}`,
    `const answeredAt = performance.now()`,
    `process.on("exit", () => { writeSync(1, JSON.stringify({ answer, lingerMs: performance.now() - answeredAt })) })`,
  ].join("\n")
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`the run process exited ${exitCode}: ${stderr}`)
  const report: LingerReport = JSON.parse(stdout)
  return report
}
