/** Source for a guardian stub, for a test that runs the process supervisor
 *  against a guardian whose behaviour it decides. Every stub answers the two
 *  frames that must succeed before any lease exists - the handshake that
 *  binds the control channel, and the generation the launcher leases into -
 *  and differs only in what it does with `adopt` and in the `prelude` it runs
 *  first. */
export function stubGuardian(onAdopt: string, prelude = ""): string {
  return [
    prelude,
    `const reply = (frame) => process.stdout.write(JSON.stringify({ v: 1, ...frame }) + "\\n")`,
    `for await (const chunk of Bun.stdin.stream()) {`,
    `  for (const line of new TextDecoder().decode(chunk).split("\\n")) {`,
    `    const frame = line.trim() ? JSON.parse(line) : undefined`,
    `    if (frame?.kind === "hello") reply({ kind: "ready", id: frame.id, pid: process.pid })`,
    `    if (frame?.kind === "open") reply({ kind: "opened", id: frame.id, generation: frame.generation })`,
    `    if (frame?.kind === "adopt") { ${onAdopt} }`,
    `  }`,
    `}`,
  ].join("\n")
}

/** Source for a guardian that ends its control output after adoption, but retains
 * its leases until one second after its control input ends. */
export const MUTE_GUARDIAN = [
  // Windows Bun leaves stdout open after closeSync(1); close its native handle.
  `const fs = require("node:fs")`,
  `const closeStdout = () => {`,
  `  if (process.platform !== "win32") { fs.closeSync(1); return }`,
  `  const { dlopen, FFIType } = require("bun:ffi")`,
  `  const kernel = dlopen("kernel32.dll", {`,
  `    GetStdHandle: { args: [FFIType.u32], returns: FFIType.ptr },`,
  `    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },`,
  `  })`,
  `  if (!kernel.symbols.CloseHandle(kernel.symbols.GetStdHandle(0xfffffff5))) throw new Error("standard output pipe close failed")`,
  `}`,
  `const reply = (frame) => fs.writeSync(1, JSON.stringify({ v: 1, ...frame }) + "\\n")`,
  `for await (const chunk of Bun.stdin.stream()) {`,
  `  for (const line of new TextDecoder().decode(chunk).split("\\n")) {`,
  `    const frame = line.trim() ? JSON.parse(line) : undefined`,
  `    if (frame?.kind === "hello") reply({ kind: "ready", id: frame.id, pid: process.pid })`,
  `    if (frame?.kind === "open") reply({ kind: "opened", id: frame.id, generation: frame.generation })`,
  `    if (frame?.kind === "adopt") { reply({ kind: "adopted", id: frame.id, token: frame.token }); setTimeout(closeStdout, 300) }`,
  `  }`,
  `}`,
  `setTimeout(() => process.exit(0), 1_000)`,
].join("\n")
