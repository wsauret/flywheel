import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** Runs one launcher subprocess and returns its stdout. A nonzero exit throws
 *  with the command and its stderr. */
export async function command(argv: string[], cwd: string, env?: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true, ...(env === undefined ? {} : { env }) });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

/** The Python interpreter of the installed Harbor CLI, which can import Harbor's models. */
export function harborPython(): string {
  const binary = Bun.which("harbor");
  if (binary === null) throw new Error("harbor CLI not found");
  return join(dirname(realpathSync(binary)), "python");
}
